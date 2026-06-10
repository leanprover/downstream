import * as core from "@actions/core";
import * as github from "@actions/github";

import type { getOctokit } from "@actions/github";

type Octokit = ReturnType<typeof getOctokit>;

interface StatusMessageOptions {
  owner: string;
  repo: string;
  /** The PR (or issue) number to post the status message on. */
  issueNumber: number;
  /** The status message body (Markdown). */
  body: string;
  /** Magic string identifying this status message. */
  marker: string;
  /**
   * When true, omit the marker from the posted message so a later
   * post-or-update starts a fresh message instead of overwriting this one.
   */
  final: boolean;
}

/**
 * Posts the status message on the PR, or updates the existing one in place.
 *
 * The marker is embedded as an invisible HTML comment so the message can be
 * found again on a later run. A final update omits the marker, which "releases"
 * the message: the next post-or-update finds no marked comment and creates a
 * new one.
 *
 * @returns The ID of the created or updated comment.
 */
async function postOrUpdateStatus(
  octokit: Octokit,
  options: StatusMessageOptions,
): Promise<number> {
  const { owner, repo, issueNumber, body, marker, final } = options;
  const tag = hiddenMarker(marker);
  const newBody = final ? body : `${body}\n\n${tag}`;

  const existing = await findExistingComment(
    octokit,
    owner,
    repo,
    issueNumber,
    tag,
  );

  if (existing !== undefined) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing,
      body: newBody,
    });
    return data.id;
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: newBody,
  });
  return data.id;
}

function hiddenMarker(marker: string): string {
  return `<!-- status-message:${marker} -->`;
}

/** Finds the bot's own comment carrying the marker, if any. */
async function findExistingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  tag: string,
): Promise<number | undefined> {
  const login = await authenticatedLogin(octokit);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const match = comments.find(
    (comment) =>
      (comment.body?.includes(tag) ?? false) &&
      (login === undefined || comment.user?.login === login),
  );
  return match?.id;
}

/**
 * The login of the token's user, used to avoid matching marker-bearing comments
 * posted by someone else. Returns undefined when the token cannot resolve a user
 * (e.g. some installation tokens), in which case matching falls back to the
 * marker alone.
 */
async function authenticatedLogin(
  octokit: Octokit,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    return data.login;
  } catch {
    return undefined;
  }
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const body = core.getInput("body", { required: true });
  const marker = core.getInput("marker");
  const final = core.getBooleanInput("final");
  const pr = Number.parseInt(core.getInput("pr", { required: true }), 10);
  if (Number.isNaN(pr)) {
    throw new Error('Input "pr" must be a number.');
  }

  const { owner, repo } = resolveRepository(core.getInput("repository"));

  const octokit = github.getOctokit(token);
  const commentId = await postOrUpdateStatus(octokit, {
    owner,
    repo,
    issueNumber: pr,
    body,
    marker,
    final,
  });
  core.setOutput("comment-id", commentId);
}

function resolveRepository(repository: string): {
  owner: string;
  repo: string;
} {
  if (repository === "") {
    return github.context.repo;
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error('Input "repository" must be in "owner/repo" format.');
  }
  return { owner, repo };
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
