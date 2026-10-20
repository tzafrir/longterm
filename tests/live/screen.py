"""Draws the Longterm pane in a real Claude Code, in tmux, and prints the screen.

The test kit checks the tree the plugin returns, never how a terminal lays it
out. This runs the real engine instead: a throwaway config folder, the store
seeded with snippets an earlier session left, `/longterm`, and
`tmux capture-pane` at the width asked for. No model is called, so a dummy
API key does.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

KEY = 'render-check-not-a-real-key'


def run(*args, check=True, **kw):
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def capture(session, escapes=False):
    """The screen as text; with `escapes`, its colors and styles kept as the terminal's escape codes."""
    return run('tmux', 'capture-pane', '-p', *(['-e'] if escapes else []), '-t', session).stdout


# Set, every screen a test reads is kept there too, for a person to look over.
RENDERS = os.environ.get('RENDERS_DIR')
kept = 0


def keep(styled, name):
    """Saves a screen read with its escapes under RENDERS_DIR, numbered in the order the tests read them."""
    global kept

    if not RENDERS:
        return

    kept += 1
    os.makedirs(RENDERS, exist_ok=True)
    # Only what a file name and the artifact's upload both take.
    safe = re.sub(r'[^A-Za-z0-9._-]+', '_', name)
    with open(os.path.join(RENDERS, f'{kept:03d}-{safe}.ansi'), 'w') as f:
        f.write(styled)


# What `capture-pane -e` adds to the text: colors and styles, and any other CSI or OSC sequence.
ESCAPES = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def snapshot(session, name=None):
    """The screen as text, read once and kept as `name` when given, colors and all: what is kept is what a test reads."""
    styled = capture(session, escapes=True)
    if name is not None:
        keep(styled, name)
    # As the plain capture reads it: that trims the spaces ending a row,
    # styled ones too.
    return '\n'.join(line.rstrip(' ') for line in ESCAPES.sub('', styled).split('\n'))


def wait_for(session, predicate, timeout=30.0):
    end = time.time() + timeout
    screen = ''
    while time.time() < end:
        screen = capture(session)
        if predicate(screen):
            return screen
        time.sleep(0.25)
    raise TimeoutError(f'timed out; the screen was:\n{screen}')


class Claude:
    """One Claude Code in a tmux window of its own, in a folder of its own."""

    def __init__(self, plugin_dir, claude='claude'):
        self.plugin_dir = os.path.abspath(plugin_dir)
        self.claude = shutil.which(claude) or claude
        self.home = tempfile.mkdtemp(prefix='longterm-screen-')
        self.config = os.path.join(self.home, 'config')
        self.project = os.path.join(self.home, 'project')
        os.makedirs(self.config)
        os.makedirs(self.project)
        with open(os.path.join(self.config, '.claude.json'), 'w') as f:
            json.dump(
                {
                    'hasCompletedOnboarding': True,
                    'theme': 'dark',
                    'customApiKeyResponses': {'approved': [KEY[-20:]], 'rejected': []},
                    'projects': {self.project: {'hasTrustDialogAccepted': True}},
                },
                f,
            )
        self.session = f'longterm-{os.getpid()}-{int(time.time() * 1000) % 100000}'
        # Claude Code's session id, so a seeded snippet can be this session's own.
        self.session_id = str(uuid.uuid4())

    def env(self):
        # Only these: an HTTPS_PROXY passed in stops the plugin loading.
        keep = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL') if k in os.environ}
        return {
            **keep,
            'HOME': self.home,
            'TERM': 'xterm-256color',
            'LANG': os.environ.get('LANG') or 'C.UTF-8',
            'CLAUDE_CONFIG_DIR': self.config,
            'ANTHROPIC_API_KEY': KEY,
        }

    def start(self, columns, rows):
        command = ' '.join(
            [
                'exec env -i',
                *[f"{k}='{v}'" for k, v in self.env().items()],
                f"'{self.claude}' --plugin-dir '{self.plugin_dir}' --session-id '{self.session_id}'",
            ]
        )
        run('tmux', '-u', 'new-session', '-d', '-s', self.session, '-x', str(columns), '-y', str(rows), '-c', self.project, command)
        return wait_for(self.session, lambda s: any(line.startswith('❯') for line in s.split('\n')))

    def type(self, text):
        # The prompt draws before it reads keys: type until it echoes them.
        deadline = time.time() + 20
        while time.time() < deadline:
            run('tmux', 'send-keys', '-t', self.session, '-l', text)
            try:
                wait_for(self.session, lambda s: text in s.split('❯')[-1], timeout=2)
                return
            except TimeoutError:
                run('tmux', 'send-keys', '-t', self.session, 'C-u')
        raise TimeoutError(f'the prompt never showed {text!r}:\n{capture(self.session)}')

    def command(self, text):
        self.type(text)
        time.sleep(0.3)
        run('tmux', 'send-keys', '-t', self.session, 'Enter')

    def stop(self):
        pid = run('tmux', 'display-message', '-p', '-t', self.session, '#{pane_pid}', check=False).stdout.strip()
        run('tmux', 'kill-session', '-t', self.session, check=False)
        # Claude Code writes the store as it ends: wait it out before the folder goes.
        deadline = time.time() + 15
        while pid.isdigit() and time.time() < deadline:
            try:
                os.kill(int(pid), 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)

    def store_file(self):
        """The plugin's store, as the engine names it for a plugin loaded with --plugin-dir."""
        digest = hashlib.sha256(b'longterm@inline').hexdigest()[:12]
        return os.path.join(self.config, 'plugins', 'store', f'longterm_inline-{digest}.json')

    def seed(self, snippets):
        """Leaves `snippets` in the store, `ageMs` old (an hour by default): an earlier session's, or this one's with `isMine`."""
        now_ms = int(time.time() * 1000)
        stored = {
            'nextId': max(s['id'] for s in snippets) + 1,
            'snippets': [
                {
                    'sessionId': self.session_id if s.get('isMine') else 'earlier',
                    'createdMs': now_ms - s.get('ageMs', 3_600_000),
                    'updatedMs': now_ms - s.get('ageMs', 3_600_000),
                    **{k: v for k, v in s.items() if k not in ('ageMs', 'isMine')},
                }
                for s in snippets
            ],
        }
        path = self.store_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump({f'project:{self.project}': stored}, f)

    def pane(self, columns, rows, asked=True, name=None):
        """The screen with the pane open: opened by /longterm, or by the session as it starts. Kept as `name` when given."""
        self.start(columns, rows)
        if asked:
            self.command('/longterm')
        try:
            wait_for(self.session, has_pane)
        except TimeoutError as error:
            # The engine names the store's file; the seed goes where store_file() says it does.
            raise RuntimeError(
                f'{"/longterm" if asked else "the session"} opened no pane on the snippets seeded in {self.store_file()}: '
                'if the engine names a --plugin-dir store otherwise now, store_file() must follow'
            ) from error
        time.sleep(1.0)
        return snapshot(self.session, name)

    def close(self):
        self.stop()
        shutil.rmtree(self.home, ignore_errors=True)


def has_pane(screen):
    """Whether the pane is drawn whole, around a snippet's head (`#4 …`): framed above the prompt, or docked beside the transcript."""
    try:
        return any(row.startswith('#') for row in pane_body(screen))
    except StopIteration:
        return False


def pane_body(screen):
    """The pane's rows in order, its frame and padding stripped."""
    lines = screen.split('\n')
    top = next((i for i, line in enumerate(lines) if line.lstrip().startswith('╭')), None)
    if top is None:
        return dock_body(lines)
    bottom = next(i for i, line in enumerate(lines) if i > top and line.lstrip().startswith('╰'))
    return [line.strip()[1:-1].rstrip()[1:] if line.strip().startswith('│') else line for line in lines[top + 1 : bottom]]


def dock_body(lines):
    """The rows right of the rule a docked pane draws down the screen's height, from 144 columns up, its close mark's row gone."""
    columns = [{i for i, c in enumerate(line) if c == '│'} for line in lines]
    rule = max(set().union(*columns), key=lambda i: sum(i in found for found in columns), default=None)
    if rule is None or sum(rule in found for found in columns) < len(lines) // 2:
        raise StopIteration
    return [line[rule + 1 :].rstrip() for line in lines if len(line) > rule and line[rule] == '│'][1:]


if __name__ == '__main__':
    snippets = json.load(open(sys.argv[2]))
    columns = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    claude = Claude(sys.argv[1])
    try:
        claude.seed(snippets)
        print(claude.pane(columns, int(sys.argv[4]) if len(sys.argv) > 4 else 50))
    finally:
        claude.close()
