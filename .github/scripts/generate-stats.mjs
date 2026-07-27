import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { calculateRank } from "github-readme-stats/src/calculateRank.js";
import { renderStatsCard } from "github-readme-stats/src/cards/stats.js";

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
      followers {
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
        totalCount
        nodes {
          stargazerCount
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

const fetchRepositoryStats = async () => {
  let after = null;
  let hasNextPage = true;
  let stars = 0;
  let repositoryCount = 0;

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
      (total, repository) => total + repository.stargazerCount,
      0,
    );
    repositoryCount = repositories.totalCount;
    hasNextPage = repositories.pageInfo.hasNextPage;
    after = repositories.pageInfo.endCursor;
  }

  return { repositoryCount, stars };
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
const repositories = await fetchRepositoryStats();
const stats = {
  name: contributionData.user.name || contributionData.user.login,
  totalStars: repositories.stars,
  totalCommits: contributions.totalCommitContributions,
  totalIssues:
    activity.openIssues.totalCount + activity.closedIssues.totalCount,
  totalPRs: activity.pullRequests.totalCount,
  totalPRsMerged: 0,
  mergedPRsPercentage: 0,
  totalReviews: contributions.totalPullRequestReviewContributions,
  totalDiscussionsStarted: 0,
  totalDiscussionsAnswered: 0,
  contributedTo: activity.repositoriesContributedTo.totalCount,
};
stats.rank = calculateRank({
  all_commits: false,
  commits: stats.totalCommits,
  prs: stats.totalPRs,
  issues: stats.totalIssues,
  reviews: stats.totalReviews,
  repos: repositories.repositoryCount,
  stars: stats.totalStars,
  followers: activity.followers.totalCount,
});

const svg = `${renderStatsCard(stats, {
  show_icons: true,
  hide_title: true,
  text_color: "24292e",
  bg_color: "ffffff",
})
  .replace(/[ \t]+$/gm, "")
  .trimEnd()}\n`;
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
