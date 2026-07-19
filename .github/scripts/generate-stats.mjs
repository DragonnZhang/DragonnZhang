import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const endpoint = "https://api.github.com/graphql";
const token = process.env.GITHUB_TOKEN;
const username =
  process.argv[2] || process.env.GITHUB_REPOSITORY_OWNER || "DragonnZhang";
const outputPath = path.resolve(
  process.argv[3] || path.join("profile", "stats.svg"),
);

if (!token) {
  throw new Error("GITHUB_TOKEN is required.");
}

if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) {
  throw new Error(`Invalid GitHub username: ${username}`);
}

// Keep these queries separate. GitHub rejects the equivalent combined query
// with RESOURCE_LIMITS_EXCEEDED as the account's contribution history grows.
const contributionQuery = `
  query ContributionStats($login: String!) {
    user(login: $login) {
      name
      login
      contributionsCollection {
        totalCommitContributions
        totalPullRequestReviewContributions
      }
    }
  }
`;

const activityQuery = `
  query ActivityStats($login: String!) {
    user(login: $login) {
      repositoriesContributedTo(
        first: 1
        contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
      ) {
        totalCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
    }
  }
`;

const repositoriesQuery = `
  query RepositoryStats($login: String!, $after: String) {
    user(login: $login) {
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        orderBy: { direction: DESC, field: STARGAZERS }
      ) {
        nodes {
          stargazers {
            totalCount
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const graphql = async (query, variables) => {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "DragonnZhang-profile-stats",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          `GitHub GraphQL request failed (${response.status}): ${
            body.message || response.statusText
          }`,
        );
      }

      if (body.errors?.length) {
        const details = body.errors
          .map((error) => {
            const location = error.path?.length
              ? ` at ${error.path.join(".")}`
              : "";
            return `${error.type || "GRAPHQL_ERROR"}${location}: ${error.message}`;
          })
          .join("; ");
        throw new Error(details);
      }

      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await delay(attempt * 1500);
      }
    }
  }

  throw lastError;
};

const fetchRepositoryStars = async () => {
  let after = null;
  let hasNextPage = true;
  let stars = 0;

  while (hasNextPage) {
    const data = await graphql(repositoriesQuery, {
      login: username,
      after,
    });
    const repositories = data.user?.repositories;
    if (!repositories) {
      throw new Error(`GitHub user not found: ${username}`);
    }

    stars += repositories.nodes.reduce(
      (total, repository) => total + repository.stargazers.totalCount,
      0,
    );
    hasNextPage = repositories.pageInfo.hasNextPage;
    after = repositories.pageInfo.endCursor;
  }

  return stars;
};

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value);

const renderMetric = ({ x, y, label, value, accent }) =>
  `<g transform="translate(${x} ${y})">
    <circle cx="5" cy="-5" r="5" fill="${accent}" opacity="0.22"/>
    <circle cx="5" cy="-5" r="2.5" fill="${accent}"/>
    <text x="18" y="0" class="label">${escapeXml(label)}</text>
    <text x="0" y="27" class="value">${escapeXml(formatNumber(value))}</text>
  </g>`;

const renderSvg = (stats) => {
  const metrics = [
    {
      x: 24,
      y: 69,
      label: "Stars earned",
      value: stats.stars,
      accent: "#f1c40f",
    },
    {
      x: 190,
      y: 69,
      label: "Commits · last year",
      value: stats.commits,
      accent: "#2f80ed",
    },
    {
      x: 356,
      y: 69,
      label: "Pull requests",
      value: stats.pullRequests,
      accent: "#8250df",
    },
    {
      x: 24,
      y: 126,
      label: "Issues",
      value: stats.issues,
      accent: "#cf222e",
    },
    {
      x: 190,
      y: 126,
      label: "Reviews",
      value: stats.reviews,
      accent: "#1a7f37",
    },
    {
      x: 356,
      y: 126,
      label: "Contributed to",
      value: stats.contributedTo,
      accent: "#bf8700",
    },
  ];

  const title = `${stats.name}'s GitHub stats`;
  const description = metrics
    .map(({ label, value }) => `${label}: ${formatNumber(value)}`)
    .join(", ");

  return `<svg
  width="520"
  height="178"
  viewBox="0 0 520 178"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  role="img"
  aria-labelledby="stats-title stats-description"
>
  <title id="stats-title">${escapeXml(title)}</title>
  <desc id="stats-description">${escapeXml(description)}</desc>
  <style>
    .header {
      font: 600 18px "Segoe UI", Ubuntu, Arial, sans-serif;
      fill: #2f80ed;
    }
    .label {
      font: 600 12px "Segoe UI", Ubuntu, Arial, sans-serif;
      fill: #57606a;
    }
    .value {
      font: 700 20px "Segoe UI", Ubuntu, Arial, sans-serif;
      fill: #24292f;
    }
  </style>
  <rect x="0.5" y="0.5" width="519" height="177" rx="6" fill="#ffffff" stroke="#d0d7de"/>
  <text x="24" y="34" class="header">${escapeXml(title)}</text>
  ${metrics.map(renderMetric).join("\n  ")}
</svg>
`;
};

const contributionData = await graphql(contributionQuery, { login: username });
if (!contributionData.user) {
  throw new Error(`GitHub user not found: ${username}`);
}

const activityData = await graphql(activityQuery, { login: username });
if (!activityData.user) {
  throw new Error(`GitHub user not found: ${username}`);
}

const contributions = contributionData.user.contributionsCollection;
const activity = activityData.user;
const stats = {
  name: contributionData.user.name || contributionData.user.login,
  stars: await fetchRepositoryStars(),
  commits: contributions.totalCommitContributions,
  reviews: contributions.totalPullRequestReviewContributions,
  pullRequests: activity.pullRequests.totalCount,
  issues: activity.openIssues.totalCount + activity.closedIssues.totalCount,
  contributedTo: activity.repositoriesContributedTo.totalCount,
};

const svg = renderSvg(stats);
const temporaryPath = `${outputPath}.tmp`;

await mkdir(path.dirname(outputPath), { recursive: true });
try {
  await writeFile(temporaryPath, svg, "utf8");
  await rename(temporaryPath, outputPath);
} finally {
  await rm(temporaryPath, { force: true });
}

console.log(`Generated ${path.relative(process.cwd(), outputPath)} for ${username}`);
console.log(stats);
