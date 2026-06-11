# Adaptation PRs

When a user opens a PR in the upstream repo (an _upstream PR_), they may want to
test their changes against the downstream repo, potentially patching the
subrepos in the process. For this purpose, an _adaptation PR_ for the upstream
PR can automatically be generated in the downstream repo.

For the adaptation PR, a new branch is created off a specific commit of the
downstream repo's main branch. The adaptation PR then merges the adaptation
branch back into the main branch.

In the adaptation PR, references to the upstream repo are redirected to point to
the upstream PR. This process is specific to the kind of upstream repo and
usually involves updating the toolchain and/or overriding a dependency. CI will
then build the modified repository and report the results.

The user can then make adaptations to the subrepos as required, either to get
them to build again if they were broken by the upstream PR, or to test out new
features introduced in the upstream PR.

Finally, after the upstream PR has been merged and included in the upstream
version used by the downstream repo, the adaptation PR must be merged back into
the main branch. Usually, this happens automatically, but sometimes merge
conflicts have to be fixed manually.

## PR creation, part 1 (upstream)

The adaptation process starts in the upstream repo, where an idempotent
`adaptation-check` GitHub Action must be called whenever a PR is updated in a
way that's relevant to the adaptation process:

1. When labels are added to the PR.
2. When CI becomes green on the PR.
3. Called by the downstream repo once the downstream PR has been created.

The action requires the following information (using the default values as
placeholders for the next sections):

- `label-requested` (default: `downstream requested`): The name of a label that
  users add when they want an adaptation PR in the downstream repo.
- `label-provided` (default: `downstream provided`): The name of a label that
  the action attaches to the PR once the adaptation PR exists (removing the
  `downstream requested` label in the process).
- `upstream-branch` (default: `downstream`): The name of a branch in the
  upstream repo that marks the latest upstream commit that downstream CI was
  green for.
- `downstream-repo`: The downstream repository to search for adaptation PRs and
  dispatch the downstream action in, in `owner/repo` format.
- `downstream-workflow` (default: `adaptation-create.yml`): The name of the
  workflow to call in the downstream repo that creates the adaptation PR.
- `app-token`: GitHub token for the app to use when interacting with GitHub.
  Must have access to both repos with the following permissions:
  - _Actions_ write access, to trigger the downstream action
  - _Contents_ write access, to auto-rebase the upstream PR
  - _Issues_ write access, to leave comments on the upstream PR
  - _Pull requests_ read access, to search for adaptation PRs
  - _Workflows_ read access, to wait for the downstream action
- `app-slug`: Slug of the app being used. Can be obtained at the same time as
  the token using https://github.com/actions/create-github-app-token.

The action roughly performs the following steps:

1. Check whether the PR is open. If _not_, abort/exit.
2. Check whether the PR is targeting the upstream repo's main branch. If _not_,
   abort/exit.
3. Check for a `downstream requested` label. If _not_ found, abort/exit.
4. Check for an adaptation PR.
   1. Determine the (deterministic) PR branch name for the current PR.
   2. Locate the first downstream PR based on said branch. Ignore closed PRs.
   3. If no PR is found, continue to the next step.
   4. Add the `downstream provided` label to the upstream PR.
   5. Remove the `downstream requested` label from the upstream PR.
   6. Post or update the status message to link to the adaptation PR.
   7. Abort/exit.
5. Check whether the PR is based on the `downstream` branch.
   1. Determine the merge base commit.
   2. If the merge base coincides with the `downstream` branch, continue to the
      next step.
   3. Attempt to rebase the PR onto the `downstream` branch.
   4. If no merge conflicts, continue to the next step.
   5. Post or update the status message to explain that the user must rebase the
      PR onto the downstream branch.
   6. Abort/exit.
6. Check whether CI is green. If _not_ green...
   1. Post or update the status message to explain that we're waiting for CI.
   2. Abort/exit.
7. Dispatch the `adaptation-create.yml` action in the downstream repo. Provide
   the current PR number as payload. If everything is configured properly, that
   action will re-dispatch our action once the PR has been created. It should be
   fine to re-trigger the action because it should be both concurrency-limited
   and idempotent, so we don't need to be too careful about dispatching it.
8. Post or update the status message to explain that we're waiting for
   downstream CI. Link the exact CI run too, if possible.

## PR creation, part 2 (downstream)

Once dispatched by the upstream action, the `adaptation-create.yml` action in
the downstream repo must now create the adaptation branch and the adaptation PR.
The action requires the following information:

- `upstream-pr`: The number of the upstream PR. Provided as dispatch payload.
- `downstream-branch` (default: `nightly-latest`): The branch corresponding to
  the `downstream` branch in the upstream repo. It marks the last time CI on the
  downstream repo main branch was green.
- `label` (default: `adaptations`): A label exclusively for all auto-generated
  adaptation PRs.
- `upstream-token`: A GitHub token with sufficient permissions to dispatch the
  upstream CI.

The action roughly performs the following steps:

1. Compute the adaptation branch name: `adaptation-<upstream PR number>` (e.g.
   `adaptation-1234`).
2. Check for any non-closed PR based on a branch of this name. If one is found,
   abort/exit.
3. Create or reset the adaptation branch to the `nightly-latest` branch.
4. Perform downstream-specific changes so the adaptation branch uses the
   upstream PR in some way; usually updating the toolchain and/or overriding a
   dependency.
5. Push the adaptation branch.
6. Create an adaptation PR merging the adaptation branch back into the main
   branch. Mention the original PR in the title and maybe description.
7. Dispatch the upstream action, so it can update its status message to link the
   adaptation PR.

## PR updates

Whenever CI finishes running on an adaptation PR, post or update the status
message on the adaptation PR to include the latest build report.

## PR merging

After CI updates whatever it uses to reference the upstream repo (usually the
toolchain and/or a dependency override), it needs to merge any adaptation PRs
whose upstream PRs have now become available. How this set of PRs is determined
is specific to the upstream repo. However, the process of merging the adaptation
PRs stays the same. Note that the PRs should be merged sequentially by the
toolchain update CI, to prevent conflicts when two PRs are merged
simultaneously.

1. If the PR is not open, do nothing.
2. If the PR is already labeled `merge required`, do nothing.
3. Label the PR `merge required` so it is easy to locate all to-be-merged
   adaptation PRs.
4. Check if CI is green. If it is not, leave a message pinging the upstream PR
   author and telling them to fix CI and merge the PR.
5. Squash-merge the PR using the GitHub API. If it fails, leave a message
   pinging the upstream PR author and tell them to merge manually.

## Helper actions

The following actions are used in multiple different places and therefore
provided as separate actions.

### Finding an adaptation PR

The adaptation branch name is deterministic and only depends on the upstream PR
number: `adaptation-<PR number>` (e.g. `adaptation-1234`).

To find an adaptation PR for an upstream PR, search the downstream repo for PRs
from the adaptation branch for said upstream PR. Only open and merged PRs count,
explicitly closed PRs should be ignored. This allows people to re-generate an
adaptation PR by closing the existing one and triggering another to be
generated.

### Posting or updating a status message

A status message contains a constant magic string as invisible comment. This,
along with the message author, allows us to determine whether we've already
posted to the PR before and can just update an existing message, or whether we
need to post an entirely new message.

If a status message contains the final state of some process and the next
process should use a new message, we can omit the magic string in our final
status update, forcing a new message for the next status update.
