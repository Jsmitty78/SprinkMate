#!/usr/bin/env python3
"""Run already-built XCTest bundles with opt-in local server integration settings.

Only a token file path is passed to the Simulator test host. Its contents are never
printed, put into process arguments, or written into the Xcode project.
"""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--simulator', required=True, help='An installed simulator device UUID')
parser.add_argument('--url', default='http://127.0.0.1:4310')
parser.add_argument('--token-file', type=Path, default=root.parent / '.data' / 'access-token')
args = parser.parse_args()
if not args.token_file.is_file():
    parser.error('The token file does not exist; start the local server first.')
products = root / '.build' / 'Build' / 'Products'
runs = sorted(products.glob('FieldAgent_*.xctestrun'))
if not runs:
    parser.error('Run xcodebuild build-for-testing first.')
configuration = plistlib.loads(runs[-1].read_bytes())
environment = configuration['FieldAgentTests'].setdefault('EnvironmentVariables', {})
environment['FIELD_AGENT_TEST_URL'] = args.url
environment['FIELD_AGENT_TEST_TOKEN_FILE'] = str(args.token_file.resolve())
live = products / 'LiveAPI.xctestrun'
live.write_bytes(plistlib.dumps(configuration))
process_environment = dict(os.environ)
process_environment.setdefault('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer')
raise SystemExit(subprocess.call(['xcodebuild', 'test-without-building', '-xctestrun', str(live), '-destination', f'platform=iOS Simulator,id={args.simulator}'], env=process_environment))
