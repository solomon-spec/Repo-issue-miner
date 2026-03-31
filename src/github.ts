import { Config, IssueRef, PullRequestFile, PullRequestSummary, RepoTreeItem, SearchRepo } from "./types.js";
import { unique, withTimeoutSignal } from "./util.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const LONG_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface RepoSearchResponse {
  search: {
    nodes: Array<{
      __typename: "Repository";
      name: string;
      nameWithOwner: string;
      url: string;
      isArchived: boolean;
      stargazerCount: number;
      pushedAt?: string;
      description?: string | null;
      diskUsage?: number;
      primaryLanguage?: { name: string } | null;
      defaultBranchRef?: { name: string } | null;
    }>;
  };
}

type RepoSearchNode = RepoSearchResponse["search"]["nodes"][number];

interface PrSearchResponse {
  search: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
    nodes: Array<{
      __typename: "PullRequest";
      number: number;
      url: string;
      title: string;
      bodyText: string;
      mergedAt?: string | null;
      changedFiles?: number;
      baseRefName: string;
      baseRefOid: string;
      headRefOid: string;
      labels: { nodes: Array<{ name: string }> };
      closingIssuesReferences: {
        nodes: Array<{
          number: number;
          title?: string | null;
          body?: string | null;
          state?: string | null;
          url?: string | null;
          repository: { nameWithOwner: string };
        }>;
      };
    }>;
  };
}

interface IssueSearchResponse {
  search: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
    nodes: Array<{
      __typename: "Issue";
      number: number;
      title: string;
      url: string;
      bodyText: string;
      state: string;
      repository: { nameWithOwner: string };
      labels: { nodes: Array<{ name: string }> };
      closedByPullRequestsReferences: {
        nodes: Array<{
          number: number;
          url: string;
          title: string;
          bodyText: string;
          mergedAt?: string | null;
          changedFiles?: number;
          baseRefName: string;
          baseRefOid: string;
          headRefOid: string;
          labels: { nodes: Array<{ name: string }> };
        }>;
      };
    }>;
  };
}

interface TimelineEvent {
  event?: string;
  source?: {
    type?: string;
    issue?: {
      number?: number;
      html_url?: string;
      title?: string;
      body?: string;
      state?: string;
      repository_url?: string;
      pull_request?: unknown;
    };
  };
}

interface CachedResponse {
  expiresAt: number;
  value: unknown;
}

const sharedResponseCache = new Map<string, CachedResponse>();

function stableValue(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => stableValue(item));
  }
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, stableValue(value)]),
    );
  }
  return input;
}

export class GitHubClient {
  constructor(private readonly config: Config) {}

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-issue-miner/0.1.0",
      ...extra,
    };
    if (this.config.githubToken) {
      headers.Authorization = `Bearer ${this.config.githubToken}`;
    }
    return headers;
  }

  private cacheKey(kind: string, payload: unknown): string {
    return `${kind}:${JSON.stringify(stableValue(payload))}`;
  }

  private getCached<T>(key: string): T | undefined {
    const cached = sharedResponseCache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      sharedResponseCache.delete(key);
      return undefined;
    }
    return cached.value as T;
  }

  private setCached(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (sharedResponseCache.has(key)) {
      sharedResponseCache.delete(key);
    }
    sharedResponseCache.set(key, {
      expiresAt: Date.now() + ttlMs,
      value,
    });
    while (sharedResponseCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = sharedResponseCache.keys().next().value;
      if (!oldestKey) break;
      sharedResponseCache.delete(oldestKey);
    }
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, cacheTtlMs = DEFAULT_CACHE_TTL_MS): Promise<T> {
    const cacheKey = this.cacheKey("graphql", { query, variables });
    const cached = this.getCached<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: this.buildHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables }),
      signal: withTimeoutSignal(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as GraphqlResponse<T>;
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${payload.errors.map((item) => item.message).join(" | ")}`);
    }
    if (!payload.data) {
      throw new Error("GitHub GraphQL request returned no data");
    }
    this.setCached(cacheKey, payload.data, cacheTtlMs);
    return payload.data;
  }

  async rest<T>(
    path: string,
    extraHeaders?: Record<string, string>,
    timeoutMs = this.config.requestTimeoutMs,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ): Promise<T> {
    const cacheKey = this.cacheKey("rest", { path, extraHeaders });
    const cached = this.getCached<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const response = await fetch(`https://api.github.com${path}`, {
      headers: this.buildHeaders(extraHeaders),
      signal: withTimeoutSignal(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub REST request failed for ${path}: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as T;
    this.setCached(cacheKey, payload, cacheTtlMs);
    return payload;
  }

  async restText(
    path: string,
    extraHeaders?: Record<string, string>,
    timeoutMs = this.config.requestTimeoutMs,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ): Promise<string> {
    const cacheKey = this.cacheKey("restText", { path, extraHeaders });
    const cached = this.getCached<string>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const response = await fetch(`https://api.github.com${path}`, {
      headers: this.buildHeaders(extraHeaders),
      signal: withTimeoutSignal(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub REST request failed for ${path}: ${response.status} ${response.statusText}`);
    }
    const payload = await response.text();
    this.setCached(cacheKey, payload, cacheTtlMs);
    return payload;
  }

  async searchRepositories(language: string, limit: number, minStars: number): Promise<SearchRepo[]> {
    const query = `
      query SearchRepos($query: String!, $limit: Int!) {
        search(type: REPOSITORY, query: $query, first: $limit) {
          nodes {
            __typename
            ... on Repository {
              name
              nameWithOwner
              url
              isArchived
              stargazerCount
              pushedAt
              description
              diskUsage
              primaryLanguage { name }
              defaultBranchRef { name }
            }
          }
        }
      }
    `;

    const maxRepoSizeKb = Math.max(1, Math.floor(this.config.maxRepoSizeBytes / 1024));
    const baseQualifiers = [
      "is:public",
      "archived:false",
      "fork:false",
      "mirror:false",
      "template:false",
      `stars:>=${minStars}`,
      `size:1..${maxRepoSizeKb}`,
      `language:${language}`,
      this.config.mergedAfter ? `pushed:>=${this.config.mergedAfter}` : "",
      "sort:updated-desc",
    ].filter(Boolean);

    const searchQueries = [
      ["docker", "test", "in:readme", ...baseQualifiers].join(" "),
      baseQualifiers.join(" "),
    ];

    const repos: SearchRepo[] = [];
    const seen = new Set<string>();

    for (const searchQuery of searchQueries) {
      if (repos.length >= limit) break;
      const data = await this.graphql<RepoSearchResponse>(query, { query: searchQuery, limit });
      for (const node of data.search.nodes) {
        if (seen.has(node.nameWithOwner)) continue;
        seen.add(node.nameWithOwner);
        repos.push(this.mapRepoSearchNode(node));
        if (repos.length >= limit) break;
      }
    }

    return repos;
  }

  async getRepository(fullName: string): Promise<SearchRepo> {
    const [owner, name] = fullName.split("/");
    if (!owner || !name) {
      throw new Error(`invalid repository name '${fullName}', expected owner/name`);
    }

    const repo = await this.rest<Record<string, unknown>>(`/repos/${owner}/${name}`);
    return {
      owner,
      name,
      fullName,
      url: typeof repo.html_url === "string" ? repo.html_url : `https://github.com/${fullName}`,
      isArchived: Boolean(repo.archived),
      stars: Number(repo.stargazers_count ?? 0),
      primaryLanguage: typeof repo.language === "string" ? repo.language : undefined,
      defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
      pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : undefined,
      diskUsageKb: typeof repo.size === "number" ? repo.size : undefined,
      description: typeof repo.description === "string" ? repo.description : undefined,
    };
  }

  private mapRepoSearchNode(node: RepoSearchNode): SearchRepo {
    const [owner, name] = node.nameWithOwner.split("/");
    return {
      owner,
      name,
      fullName: node.nameWithOwner,
      url: node.url,
      isArchived: node.isArchived,
      stars: node.stargazerCount,
      primaryLanguage: node.primaryLanguage?.name,
      defaultBranch: node.defaultBranchRef?.name ?? "main",
      pushedAt: node.pushedAt,
      diskUsageKb: node.diskUsage,
      description: node.description,
    } satisfies SearchRepo;
  }

  private mapGitHubLinkedIssue(issue: {
    number: number;
    title?: string | null;
    body?: string | null;
    state?: string | null;
    url?: string | null;
    repository: { nameWithOwner: string };
  }): IssueRef {
    const [owner, name] = issue.repository.nameWithOwner.split("/");
    return {
      owner,
      repo: name,
      number: issue.number,
      url: issue.url ?? undefined,
      title: issue.title ?? undefined,
      body: issue.body ?? undefined,
      state: issue.state ?? undefined,
      linkType: "github_linked",
    };
  }

  async searchMergedPullRequests(repo: SearchRepo, limit: number, mergedAfter?: string): Promise<PullRequestSummary[]> {
    const query = `
      query SearchMergedPrs($query: String!, $limit: Int!, $after: String) {
        search(type: ISSUE, query: $query, first: $limit, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            __typename
            ... on PullRequest {
              number
              url
              title
              bodyText
              mergedAt
              changedFiles
              baseRefName
              baseRefOid
              headRefOid
              labels(first: 20) { nodes { name } }
              closingIssuesReferences(first: 10) {
                nodes {
                  number
                  title
                  body
                  state
                  url
                  repository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    `;
    const mergedAfterQualifier = mergedAfter ? ` merged:>=${mergedAfter}` : "";
    const baseParts = [
      `repo:${repo.fullName}`,
      "is:pr",
      "is:merged",
      "linked:issue",
      mergedAfterQualifier.trim(),
      "sort:updated-desc",
    ].filter(Boolean);

    const searchQueries = [
      [...baseParts, "in:title,body", "(bug OR fix OR regression OR failure OR crash OR error)"].join(" "),
      [...baseParts, "label:bug"].join(" "),
      [...baseParts, "label:regression"].join(" "),
      [...baseParts, "label:fix"].join(" "),
      baseParts.join(" "),
    ];

    const merged = new Map<number, PullRequestSummary>();
    for (const searchQuery of searchQueries) {
      if (merged.size >= limit) break;
      let after: string | null = null;
      while (merged.size < limit) {
        const pageLimit = Math.min(Math.max(limit - merged.size, 1), 100);
        const data: PrSearchResponse = await this.graphql<PrSearchResponse>(query, { query: searchQuery, limit: pageLimit, after });
        for (const node of data.search.nodes.filter((item: PrSearchResponse["search"]["nodes"][number]) => item.__typename === "PullRequest")) {
          if (merged.has(node.number)) continue;
          merged.set(node.number, {
            number: node.number,
            url: node.url,
            title: node.title,
            body: node.bodyText,
            mergedAt: node.mergedAt,
            changedFilesCount: node.changedFiles,
            labels: node.labels.nodes.map((label: { name: string }) => label.name),
            baseRefName: node.baseRefName,
            baseRefOid: node.baseRefOid,
            headRefOid: node.headRefOid,
            linkedIssues: node.closingIssuesReferences.nodes.map((issue) => this.mapGitHubLinkedIssue(issue)),
          });
          if (merged.size >= limit) break;
        }

        if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) {
          break;
        }
        after = data.search.pageInfo.endCursor;
      }
    }

    return [...merged.values()];
  }

  async searchClosedIssuesWithMergedPullRequests(
    repo: SearchRepo,
    limit: number,
    mergedAfter?: string,
  ): Promise<PullRequestSummary[]> {
    return this.searchClosedIssuesWithMergedPullRequestsInternal(repo, {
      limit,
      mergedAfter,
      exhaustive: false,
    });
  }

  async searchAllClosedIssuesWithMergedPullRequests(
    repo: SearchRepo,
    mergedAfter?: string,
  ): Promise<PullRequestSummary[]> {
    return this.searchClosedIssuesWithMergedPullRequestsInternal(repo, {
      mergedAfter,
      exhaustive: true,
    });
  }

  private async searchClosedIssuesWithMergedPullRequestsInternal(
    repo: SearchRepo,
    opts: {
      limit?: number;
      mergedAfter?: string;
      exhaustive: boolean;
    },
  ): Promise<PullRequestSummary[]> {
    const query = `
      query SearchClosedIssues($query: String!, $limit: Int!, $after: String) {
        search(type: ISSUE, query: $query, first: $limit, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            __typename
            ... on Issue {
              number
              title
              url
              bodyText
              state
              repository { nameWithOwner }
              labels(first: 20) { nodes { name } }
              closedByPullRequestsReferences(first: 10) {
                nodes {
                  number
                  url
                  title
                  bodyText
                  mergedAt
                  changedFiles
                  baseRefName
                  baseRefOid
                  headRefOid
                  labels(first: 20) { nodes { name } }
                }
              }
            }
          }
        }
      }
    `;

    const mergedAfter = opts.mergedAfter;
    const limit = opts.limit;
    const baseParts = [
      `repo:${repo.fullName}`,
      "is:issue",
      "is:closed",
      "linked:pr",
      mergedAfter ? `updated:>=${mergedAfter}` : "",
      "sort:updated-desc",
    ].filter(Boolean);

    const searchQueries = opts.exhaustive
      ? [baseParts.join(" ")]
      : [
        [...baseParts, "in:title,body", "(bug OR fix OR regression OR failure OR crash OR error)"].join(" "),
        [...baseParts, "label:bug"].join(" "),
        [...baseParts, "label:regression"].join(" "),
        [...baseParts, "label:fix"].join(" "),
        baseParts.join(" "),
      ];

    const merged = new Map<number, PullRequestSummary>();
    for (const searchQuery of searchQueries) {
      if (!opts.exhaustive && typeof limit === "number" && merged.size >= limit) break;
      let after: string | null = null;

      while (true) {
        const pageLimit = opts.exhaustive
          ? 100
          : Math.min(Math.max(limit ?? 1, 1), 100);
        const data: IssueSearchResponse = await this.graphql<IssueSearchResponse>(query, { query: searchQuery, limit: pageLimit, after });
        for (const issueNode of data.search.nodes.filter((item: IssueSearchResponse["search"]["nodes"][number]) => item.__typename === "Issue")) {
          const [issueOwner, issueRepo] = issueNode.repository.nameWithOwner.split("/");
          const linkedIssue: IssueRef = {
            owner: issueOwner,
            repo: issueRepo,
            number: issueNode.number,
            url: issueNode.url,
            title: issueNode.title,
            body: issueNode.bodyText,
            state: issueNode.state,
            linkType: "github_linked",
          };

          for (const prNode of issueNode.closedByPullRequestsReferences.nodes) {
            if (!prNode.mergedAt) continue;
            if (mergedAfter && prNode.mergedAt < mergedAfter) continue;

            const existing = merged.get(prNode.number);
            if (existing) {
              const linkedIssues = existing.linkedIssues ?? [];
              const key = `${linkedIssue.owner}/${linkedIssue.repo}#${linkedIssue.number}`;
              if (!linkedIssues.some((issue) => `${issue.owner}/${issue.repo}#${issue.number}` === key)) {
                linkedIssues.push(linkedIssue);
              }
              continue;
            }

            merged.set(prNode.number, {
              number: prNode.number,
              url: prNode.url,
              title: prNode.title,
              body: prNode.bodyText,
              mergedAt: prNode.mergedAt,
              changedFilesCount: prNode.changedFiles,
              labels: prNode.labels.nodes.map((label: { name: string }) => label.name),
              baseRefName: prNode.baseRefName,
              baseRefOid: prNode.baseRefOid,
              headRefOid: prNode.headRefOid,
              linkedIssues: [linkedIssue],
            });
            if (!opts.exhaustive && typeof limit === "number" && merged.size >= limit) break;
          }
          if (!opts.exhaustive && typeof limit === "number" && merged.size >= limit) break;
        }

        if ((!opts.exhaustive && typeof limit === "number" && merged.size >= limit)
          || !data.search.pageInfo.hasNextPage
          || !data.search.pageInfo.endCursor) {
          break;
        }
        after = data.search.pageInfo.endCursor;
      }
    }

    return typeof limit === "number"
      ? [...merged.values()].slice(0, limit)
      : [...merged.values()];
  }

  async listPullRequestFiles(repo: SearchRepo, prNumber: number): Promise<PullRequestFile[]> {
    const files: PullRequestFile[] = [];
    let page = 1;
    while (page <= 30) {
      const batch = await this.rest<Array<Record<string, unknown>>>(`/repos/${repo.owner}/${repo.name}/pulls/${prNumber}/files?per_page=100&page=${page}`);
      if (batch.length === 0) break;
      files.push(
        ...batch.map((item) => ({
          filename: String(item.filename),
          status: String(item.status),
          additions: Number(item.additions ?? 0),
          deletions: Number(item.deletions ?? 0),
          changes: Number(item.changes ?? 0),
        })),
      );
      page += 1;
    }
    return files;
  }

  async getRepoTree(repo: SearchRepo, ref: string): Promise<RepoTreeItem[]> {
    const response = await this.rest<{ tree: Array<{ path: string; type: string; size?: number }> }>(
      `/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      undefined,
      Math.max(this.config.requestTimeoutMs, 120_000),
      LONG_CACHE_TTL_MS,
    );
    return response.tree.map((item) => ({ path: item.path, type: item.type, size: item.size }));
  }

  async getReadme(repo: SearchRepo, ref: string): Promise<string | undefined> {
    try {
      return await this.restText(`/repos/${repo.owner}/${repo.name}/readme?ref=${encodeURIComponent(ref)}`, {
        Accept: "application/vnd.github.raw+json",
      }, this.config.requestTimeoutMs, LONG_CACHE_TTL_MS);
    } catch {
      return undefined;
    }
  }

  async getFile(repo: SearchRepo, path: string, ref: string): Promise<string | undefined> {
    try {
      return await this.restText(`/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
        Accept: "application/vnd.github.raw+json",
      }, this.config.requestTimeoutMs, LONG_CACHE_TTL_MS);
    } catch {
      return undefined;
    }
  }

  async getIssue(owner: string, repo: string, number: number): Promise<IssueRef | undefined> {
    try {
      const issue = await this.rest<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${number}`);
      if (issue.pull_request) {
        return undefined;
      }
      return {
        owner,
        repo,
        number,
        url: typeof issue.html_url === "string" ? issue.html_url : undefined,
        title: typeof issue.title === "string" ? issue.title : undefined,
        body: typeof issue.body === "string" ? issue.body : undefined,
        state: typeof issue.state === "string" ? issue.state : undefined,
        linkType: "body_reference",
      };
    } catch {
      return undefined;
    }
  }

  async getTimelineLinkedIssues(repo: SearchRepo, prNumber: number): Promise<IssueRef[]> {
    try {
      const timeline = await this.rest<TimelineEvent[]>(`/repos/${repo.owner}/${repo.name}/issues/${prNumber}/timeline?per_page=100`, {
        Accept: "application/vnd.github+json",
      });
      const items = timeline
        .filter((event) => event.event === "cross-referenced")
        .map((event) => event.source?.issue)
        .filter((issue): issue is NonNullable<NonNullable<TimelineEvent["source"]>["issue"]> => Boolean(issue && issue.number && !issue.pull_request));

      return unique(
        items.map((issue) => `${issue.repository_url ?? `${repo.owner}/${repo.name}`}:${issue.number}`),
      ).map((key) => {
        const match = items.find((item) => `${item.repository_url ?? `${repo.owner}/${repo.name}`}:${item.number}` === key);
        if (!match) {
          throw new Error(`Timeline issue match disappeared for ${key}`);
        }
        const repoUrl = match.repository_url ?? `https://api.github.com/repos/${repo.owner}/${repo.name}`;
        const parts = repoUrl.split("/");
        const issueOwner = parts.at(-2) ?? repo.owner;
        const issueRepo = parts.at(-1) ?? repo.name;
        return {
          owner: issueOwner,
          repo: issueRepo,
          number: Number(match.number),
          url: match.html_url,
          title: match.title,
          body: match.body,
          state: match.state,
          linkType: "timeline_cross_reference" as const,
        };
      });
    } catch {
      return [];
    }
  }
}
