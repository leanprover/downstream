import * as core from "@actions/core";
import * as github from "@actions/github";
import { postOrUpdateStatus } from "../lib/status-message";
import { abort, assert, exit, getInput, Octokit, parseRepo } from "../lib/util";

import type { GetResponseDataTypeFromEndpointMethod as Response } from "@octokit/types";
export type Pr = Response<Octokit["rest"]["pulls"]["get"]>;
export type ListPr = Response<Octokit["rest"]["pulls"]["list"]>[number];

const labelRequested = getInput("label-requested");
const labelProvided = getInput("label-provided");
const upstreamRepo = github.context.repo;
const upstreamBranch = getInput("upstream-branch");
const downstreamRepo = parseRepo(getInput("downstream-repo"));
const downstreamWorkflow = getInput("downstream-workflow");
const appToken = getInput("app-token");
const appSlug = getInput("app-slug");
const octo = github.getOctokit(appToken);

function determineUpstreamPrNumber(): number {
  const eventName = github.context.eventName;
  if (eventName === "pull_request_target") {
    const payload = github.context.payload.pull_request;
    assert(payload !== undefined, "Expected pull_request payload");
    return payload.number;
  } else if (eventName === "workflow_run") {
    const payload = github.context.payload.workflow_run;
    assert(payload !== undefined, "Expected workflow_run payload");
    assert(payload.pull_requests.length > 0, "No PR found in payload");
    return payload.pull_requests[0].number;
  } else {
    abort(`Unsupported event type "${eventName}".`);
  }
}

async function getUpstreamPr(): Promise<Pr> {
  const { data } = await octo.rest.pulls.get({
    ...upstreamRepo,
    pull_number: determineUpstreamPrNumber(),
  });
  return data;
}

function ensurePrIsOpen(uPr: Pr): void {
  if (uPr.state === "open") {
    core.info("PR is open, continuing...");
    return;
  }
  exit("PR is not open");
}

function ensurePrTargetsDefaultBranch(uPr: Pr): void {
  const defaultBranch = uPr.base.repo.default_branch;
  if (uPr.base.ref === defaultBranch) {
    core.info(`PR is targeting "${defaultBranch}", continuing...`);
    return;
  }
  exit(`PR is not targeting "${defaultBranch}"`);
}

function ensurePrIsLabeled(uPr: Pr): void {
  const labeled = uPr.labels.some((label) => label.name === labelRequested);
  if (labeled) {
    core.info(`PR is labeled "${labelRequested}", continuing...`);
    return;
  }
  exit(`PR is not labeled "${labelRequested}"`);
}

async function updateStatus(
  uPr: Pr,
  message: string,
  final: boolean = false,
): Promise<void> {
  core.info(`Updating status message on #${uPr.number}...`);
  await postOrUpdateStatus({
    octo: octo,
    appSlug: appSlug,
    repo: upstreamRepo,
    issueNumber: uPr.number,
    body: message,
    final: final,
  });
}

async function findAdaptationPrFor(uPr: Pr): Promise<ListPr | undefined> {
  const branch = `adaptation-${uPr.number}`;
  core.info(
    `Finding adaptation PR for #${uPr.number} ` +
      `(repo "${downstreamRepo.owner}/${downstreamRepo.repo}", ` +
      `branch "${branch}")...`,
  );
  const prs = await octo.paginate(octo.rest.pulls.list, {
    ...downstreamRepo,
    state: "all",
    head: `${downstreamRepo.owner}:${branch}`,
    per_page: 100,
  });
  const pr = prs.find((pr) => pr.state === "open" || pr.merged_at !== null);
  if (pr === undefined) {
    core.info(`Found no adaptation PR for #${uPr.number}.`);
  } else {
    core.info(`Found adaptation PR #${pr.number} for #${uPr.number}.`);
  }
  return pr;
}

async function addLabel(uPr: Pr, label: string): Promise<void> {
  core.info(`Adding label "${label}" to #${uPr.number}...`);
  await octo.rest.issues.addLabels({
    ...upstreamRepo,
    issue_number: uPr.number,
    labels: [label],
  });
}

async function removeLabel(uPr: Pr, label: string): Promise<void> {
  core.info(`Removing label "${label}" from #${uPr.number}...`);
  await octo.rest.issues.removeLabel({
    ...upstreamRepo,
    issue_number: uPr.number,
    name: label,
  });
}

async function checkForAdaptationPr(uPr: Pr): Promise<void> {
  const aPr = await findAdaptationPrFor(uPr);
  if (aPr === undefined) return;

  await addLabel(uPr, labelProvided);
  await removeLabel(uPr, labelRequested);
  await updateStatus(uPr, `Adaptation PR #${aPr.number} is available.`, true);

  exit(`Adaptation PR #${aPr.number} is available.`);
}

async function checkForCorrectMergeBase(uPr: Pr): Promise<void> {
  core.info("Checking merge base...");
  const { data: branch } = await octo.rest.repos.getBranch({
    ...upstreamRepo,
    branch: upstreamBranch,
  });
  const { data: compare } = await octo.rest.repos.compareCommits({
    ...upstreamRepo,
    base: uPr.base.sha,
    head: uPr.head.sha,
  });

  if (compare.merge_base_commit.sha === branch.commit.sha) {
    core.info(`Merge base coincides with "${upstreamBranch}", continuing...`);
    return;
  }

  // TODO Attempt rebase and force-push if successful
  await updateStatus(
    uPr,
    `Please rebase this PR onto the \`${upstreamBranch}\` branch, ` +
      `or merge \`${upstreamBranch}\` into this PR. ` +
      `In the end, the merge base of this PR ` +
      `must coincide with the tip of \`${upstreamBranch}\`.`,
  );

  exit("Merge base is not correct");
}

async function checkForGreenCi(uPr: Pr): Promise<void> {
  // TODO Get checks for current commit instead?
  // https://docs.github.com/en/rest/checks?apiVersion=2026-03-10

  if (github.context.eventName !== "workflow_run")
    exit("Not triggered by CI workflow run");

  const payload = github.context.payload.workflow_run;
  assert(payload !== undefined, "Expected workflow_run payload");

  if (payload.conclusion === "success") {
    core.info("CI is green, continuing...");
    return;
  }

  await updateStatus(uPr, "Waiting for CI to succeed...");
  exit("CI is not green");
}

async function getDownstreamDefaultBranch(): Promise<string> {
  core.info("Fetching downstream default branch...");
  const { data: repo } = await octo.rest.repos.get({ ...downstreamRepo });
  core.info(`Downstream default branch is "${repo.default_branch}"`);
  return repo.default_branch;
}

async function dispatchDownstreamWorkflow(
  uPr: Pr,
  defaultBranch: string,
): Promise<number> {
  core.info(`Dispatching downstream workflow "${downstreamWorkflow}"...`);

  const { data: dispatch } = await octo.rest.actions.createWorkflowDispatch({
    ...downstreamRepo,
    workflow_id: downstreamWorkflow,
    ref: defaultBranch,
    inputs: { upstream_pr: String(uPr.number) },
  });

  const workflowRunId = (dispatch as any).workflow_run_id as number;
  core.info(`Downstream workflow run ID is ${workflowRunId}`);

  return workflowRunId;
}

async function waitForDownstreamAction(runId: number): Promise<string> {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 30 * 1000));

    const { data } = await octo.rest.actions.getWorkflowRun({
      ...downstreamRepo,
      run_id: runId,
    });
    console.info(`Run status: ${data.status}, conclusion: ${data.conclusion}`);

    if (data.conclusion !== null) return data.conclusion;
  }
}

async function createAdaptationPrFor(uPr: Pr): Promise<void> {
  core.info("Creating adaptation PR...");

  try {
    await updateStatus(uPr, "Opening adaptation PR...");

    const defaultBranch = await getDownstreamDefaultBranch();
    const runId = await dispatchDownstreamWorkflow(uPr, defaultBranch);
    const conclusion = await waitForDownstreamAction(runId);

    if (conclusion === "success") return;
    await updateStatus(
      uPr,
      "Failed to open adaptation PR.\n\n" +
        "The downstream workflow did not complete successfully. " +
        "Please check the downstream workflow run for details, " +
        "and re-trigger the workflow after any issues have been fixed.",
    );
    exit(`Downstream workflow run completed with conclusion "${conclusion}"`);
  } catch (error) {
    await updateStatus(
      uPr,
      "Failed to open adaptation PR.\n\n" +
        "Please check the logs of this workflow run for details, " +
        "and re-trigger the workflow after any issues have been fixed.",
    );
    throw error;
  }
}

async function run(): Promise<void> {
  const uPr = await getUpstreamPr();
  ensurePrIsOpen(uPr);
  ensurePrTargetsDefaultBranch(uPr);
  ensurePrIsLabeled(uPr);

  await checkForAdaptationPr(uPr);
  await checkForCorrectMergeBase(uPr);
  await checkForGreenCi(uPr);

  await createAdaptationPrFor(uPr);

  // Calling this a second time to update the status message with the new
  // adaptation PR as soon as possible. The alternative would've been to somehow
  // get dispatched by the downstream workflow or something.
  await checkForAdaptationPr(uPr);
}

run().catch((error) => {
  abort(error instanceof Error ? error.message : String(error));
});
