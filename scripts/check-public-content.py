#!/usr/bin/env python3
"""Check only the files eligible for publication; never print a detected secret."""
import argparse
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--private-env', help='Optional outside-repository env file for exact-value negative checks')
args = parser.parse_args()
paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
patterns = [re.compile(rb'lst_[a-f0-9]{48,}'), re.compile(rb'sk-ws-[A-Za-z0-9._-]{30,}'), re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'), re.compile(rb'github_pat_[A-Za-z0-9_]{30,}'), re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}')]
secrets = []
if args.private_env:
    private = pathlib.Path(args.private_env).resolve()
    if private.is_relative_to(root):
        raise SystemExit('Private comparison configuration must be outside the repository')
    for line in private.read_text().splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if any(word in key for word in ['KEY', 'PASSWORD', 'SECRET']) and len(value) > 20:
                secrets.append(value.encode())
failures = []
count = 0
for name in sorted(set(paths)):
    if not name:
        continue
    path = root / name
    if not path.is_file():
        continue
    count += 1
    parts = pathlib.PurePosixPath(name).parts
    forbidden = (parts[0] in ['mobile', 'deploy', '.gitlab', '.env', 'output', 'data'] or name.startswith('.gitlab-ci')
                 or path.suffix.lower() in ['.safetensors', '.ckpt', '.pt', '.onnx', '.tflite', '.pem', '.key']
                 or (path.name.startswith('.env') and path.name != '.env.example'))
    if forbidden:
        failures.append((name, 'excluded release content'))
    content = path.read_bytes()
    if any(pattern.search(content) for pattern in patterns) or any(value in content for value in secrets):
        failures.append((name, 'credential/private-key signature; value suppressed'))
    if re.search(rb'https?://[^/\s]+:[^/@\s]+@', content):
        failures.append((name, 'URL contains embedded credentials'))
if failures:
    for name, reason in failures:
        print(f'{name}: {reason}', file=sys.stderr)
    raise SystemExit(1)
print(f'Publication content checks passed: {count} files; no known private credentials or excluded model/deployment assets.')
