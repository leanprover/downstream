import re
import shlex
import subprocess
from os import PathLike
from pathlib import Path
from subprocess import CompletedProcess

type Arg = str | bytes | PathLike[str] | PathLike[bytes]


def run(
    *args: Arg, check: bool = True, cwd: Path | None = None, capture: bool = False
) -> CompletedProcess[str]:
    print(f"$ {' '.join(shlex.quote(str(arg)) for arg in args)}")
    return subprocess.run(args, check=check, cwd=cwd, capture_output=capture, text=True)


def normalize_url(url: str) -> str:
    # GitHub URLs
    if match := re.fullmatch(
        r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/.]+?)(?:\.git)?/?",
        url,
    ):
        full_name = match.group(1)
        return f"https://github.com/{full_name}"

    return url
