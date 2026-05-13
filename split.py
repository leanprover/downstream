import json
import os
import re
import shutil
from argparse import ArgumentParser
from dataclasses import dataclass
from pathlib import Path
from typing import Generator

import tomllib

from util import normalize_url, run


@dataclass
class Subrepo:
    name: str
    url: str
    rev: str

    @property
    def path(self) -> Path:
        return Path(self.name)


def load_subrepos(path: Path) -> Generator[Subrepo]:
    for name, data in tomllib.loads(path.read_text()).items():
        url = normalize_url(data["url"])
        rev = data["rev"]
        yield Subrepo(name=name, url=url, rev=rev)


class Updater:
    def __init__(self) -> None:
        self.subrepos = list(load_subrepos(Path("repos.toml")))
        self.subrepos_by_name = {repo.name: repo for repo in self.subrepos}
        self.subrepos_by_url = {repo.url: repo for repo in self.subrepos}

    def reset_repo(self) -> None:
        run("git", "clean", "-dffx")
        run("git", "restore", "--staged", "--worktree", ".")

    def fetch_sha_tree(self, url: str, rev: str) -> tuple[str, str]:
        run("git", "fetch", "--depth=1", url, rev)
        sha = run("git", "rev-parse", "FETCH_HEAD", capture=True).stdout.strip()
        tree = run("git", "rev-parse", "FETCH_HEAD^{tree}", capture=True).stdout.strip()
        return sha, tree

    def restore_tree_to(self, tree: str, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        run(
            *("git", f"--work-tree={path}"),
            *("restore", "--worktree", f"--source={tree}", "."),
        )

    def fixup_subrepo_toolchain(self, subrepo: Subrepo) -> None:
        # Remove all lean-toolchain files
        for file in subrepo.path.glob("**/lean-toolchain"):
            if file.is_file():
                file.unlink()

    def fixup_subrepo_dependencies(self, subrepo: Subrepo) -> None:
        manifest_path = subrepo.path / "lake-manifest.json"
        override_path = subrepo.path / ".lake" / "package-overrides.json"

        manifest = json.loads(manifest_path.read_text())

        packages = []
        for package in manifest["packages"]:
            if package["type"] != "git":
                continue
            url = normalize_url(package["url"])
            repo = self.subrepos_by_url.get(url)
            if not repo:
                continue

            package["type"] = "path"
            package["dir"] = f"../{repo.name}"
            package["scope"] = ""
            del package["url"]
            del package["rev"]
            del package["inputRev"]

            packages.append(package)

        overrides = {"version": manifest["version"], "packages": packages}
        override_path.parent.mkdir(parents=True, exist_ok=True)
        override_path.write_text(json.dumps(overrides, indent=2))

    def commit(self, msg: str) -> None:
        result = run("git", "diff", "--staged", "--quiet", "--exit-code", check=False)
        if result.returncode == 0:
            return
        run("git", "commit", "-m", msg)

    def fixup_subrepo_and_commit(self, subrepo: Subrepo, sha: str, msg: str) -> None:
        self.fixup_subrepo_toolchain(subrepo)
        self.fixup_subrepo_dependencies(subrepo)

        message = "\n".join(
            [
                f"downstream: {msg}",
                "",
                f"downstream-repo: {subrepo.name}",
                f"downstream-url: {subrepo.url}",
                f"downstream-rev: {subrepo.rev}",
                f"downstream-sha: {sha}",
            ]
        )

        run("git", "add", subrepo.path)
        run("git", "add", "--force", subrepo.path / ".lake" / "package-overrides.json")
        self.commit(message)

    def find_latest_subrepo_sha(self, subrepo: Subrepo) -> str:
        message = run(
            *("git", "log", "-1", "-E"),
            f"--grep=^downstream-repo: {re.escape(subrepo.name)}$",
            "--format=%B",
            capture=True,
        ).stdout

        for line in message.splitlines():
            if match := re.fullmatch(r"downstream-sha: (.+)", line):
                return match.group(1).strip()

        raise ValueError(f"no previous commit found for subrepo {subrepo.name}")

    def get_tree_in_head(self, path: str) -> str:
        return run("git", "rev-parse", f"HEAD:{path}", capture=True).stdout.strip()

    def merge_trees_preferring_theirs(self, base: str, ours: str, theirs: str) -> str:
        return run(
            *("git", "merge-tree", "--write-tree"),
            *(f"--merge-base={base}", "-Xtheirs", ours, theirs),
            capture=True,
        ).stdout.strip()

    def add_subrepo(self, subrepo: Subrepo) -> None:
        self.reset_repo()

        rev_sha, rev_tree = self.fetch_sha_tree(subrepo.url, subrepo.rev)
        self.restore_tree_to(rev_tree, subrepo.path)
        self.fixup_subrepo_and_commit(subrepo, rev_sha, f"add repo {subrepo.name}")

    def reset_subrepo(self, subrepo: Subrepo) -> None:
        self.reset_repo()

        rev_sha, rev_tree = self.fetch_sha_tree(subrepo.url, subrepo.rev)
        shutil.rmtree(subrepo.path)
        self.restore_tree_to(rev_tree, subrepo.path)
        self.fixup_subrepo_and_commit(subrepo, rev_sha, f"reset repo {subrepo.name}")

    def update_subrepo(self, subrepo: Subrepo) -> None:
        self.reset_repo()

        rev_sha, rev_tree = self.fetch_sha_tree(subrepo.url, subrepo.rev)
        our_tree = self.get_tree_in_head(subrepo.name)
        base_sha = self.find_latest_subrepo_sha(subrepo)
        _, base_tree = self.fetch_sha_tree(subrepo.url, base_sha)
        merged_tree = self.merge_trees_preferring_theirs(base_tree, our_tree, rev_tree)

        self.restore_tree_to(merged_tree, subrepo.path)
        self.fixup_subrepo_and_commit(subrepo, rev_sha, f"update repo {subrepo.name}")

    def remove_subrepo(self, path: Path) -> None:
        self.reset_repo()

        run("git", "rm", "-rf", path)
        self.commit(f"downstream: remove repo {path.name}")

    def add_or_update_subrepo(self, subrepo: Subrepo) -> None:
        self.reset_repo()

        if subrepo.path.exists():
            self.update_subrepo(subrepo)
        else:
            self.add_subrepo(subrepo)

    def prune_subrepos(self) -> None:
        self.reset_repo()

        for path in Path().iterdir():
            if not path.is_dir():
                continue
            if path.name.startswith("."):
                continue
            if path.name not in self.subrepos_by_name:
                self.remove_subrepo(path)

    def split_to_branch(self, subrepo: Subrepo, branch: str) -> None:
        self.reset_repo()

        our_tree = self.get_tree_in_head(subrepo.name)
        base_sha = self.find_latest_subrepo_sha(subrepo)
        self.fetch_sha_tree(subrepo.url, base_sha)

        run("git", "switch", "-c", branch, base_sha)
        self.restore_tree_to(our_tree, Path())

        run(
            *("git", "restore", "--worktree"),
            f"--source={our_tree}",
            ".",
        )

        # Remove our overrides
        run("git", "rm", "-f", ".lake/package-overrides.json")

        # Restore all lean-toolchain files from the base commit
        for file in Path().glob("**/lean-toolchain"):
            if file.is_file():
                file.unlink()
        run(
            *("git", "restore", "--worktree"),
            f"--source={base_sha}",
            ":(glob)**/lean-toolchain",
        )

        self.commit("chore: nightly adaptations")


class Args:
    downstream: Path
    subrepo: str
    branch: str


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("downstream", type=Path)
    parser.add_argument("subrepo", type=str)
    parser.add_argument("branch", type=str)
    args = parser.parse_args(namespace=Args())

    os.chdir(args.downstream)
    updater = Updater()

    subrepo = updater.subrepos_by_name[args.subrepo]
    updater.split_to_branch(subrepo, args.branch)


if __name__ == "__main__":
    main()
