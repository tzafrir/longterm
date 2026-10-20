"""The Longterm pane as a real Claude Code draws it, at narrow and wide widths.

Run with `python3 tests/live/test_pane.py` from the repository's root, with
`claude` and `tmux` on the PATH. Each case seeds the store with snippets,
starts a session in a terminal of the given size, opens the pane and reads
the screen back: every snippet's head, body and buttons show, and nothing is
cut off at the pane's bottom. Below 110 columns the pane is framed above the
prompt; from 110 it docks beside the transcript, about 88 columns at most,
and opened unasked it is drawn only from 144. With RENDERS_DIR set, each screen a test reads
is kept there, and `tests/live/renders.py` lays them out. PLUGIN_DIR draws
another copy of the plugin.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from screen import Claude, pane_body, placement, toast_body  # noqa: E402

ROOT = os.environ.get('PLUGIN_DIR') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# Each side of where the pane docks (110), where it opens unasked (144), and
# past where the dock stops growing.
WIDTHS = (36, 60, 109, 110, 144, 200, 300)
DOCK_FROM = 110
UNASKED_FROM = 144
# Tall enough that the layout spares the pane every row it asks for.
HEIGHT = 90

HOUR_MS = 3_600_000

PLAN = {
    'id': 4,
    'title': 'Ship the funnel fix',
    'body': '1. Fix the guest count\n2. Add the test\n3. Push to main\n4. Watch CI',
}

CHECKLIST = {
    'id': 2,
    'title': 'Preprod checklist',
    'body': '- [x] migrations\n- [ ] soak',
    'ageMs': 26 * HOUR_MS,
}

# Longer than any row the pane has at these widths.
LONG = {
    'id': 7,
    'title': 'Move the billing webhooks to the new queue, then retire the old worker',
    'body': 'Start with the refunds handler.',
}

JAPANESE = {
    'id': 8,
    'title': 'ステージング環境のデータベース移行を承認してから本番に進む',
    'body': '移行は月曜日に。',
    'ageMs': 2 * HOUR_MS,
}

MARKDOWN = {
    'id': 9,
    'title': 'Release notes',
    'body': '**Fixed** the `--force` flag.\n\n- One\n- Two',
}

BUTTONS = ['Copy', 'Remove']
EARLIER_BUTTONS = ['Bring', 'here', 'Copy', 'Remove']


def changed(snippet):
    """The head's note of when `snippet` last changed, as the pane writes it."""
    hours = snippet.get('ageMs', HOUR_MS) // HOUR_MS
    return f'changed {hours}h ago' if hours < 24 else f'changed {hours // 24}d ago'


class Pane(unittest.TestCase):
    def draw(self, snippets, columns, asked=True):
        claude = Claude(ROOT)
        try:
            claude.seed(snippets)
            screen = claude.pane(columns, HEIGHT, asked=asked, name=f'{self._testMethodName}-{columns}')
        finally:
            claude.close()
        body = pane_body(screen)
        context = f'at {columns} columns the pane drew {placement(screen)}:\n' + '\n'.join(body)
        self.assertEqual(placement(screen), 'dock' if columns >= DOCK_FROM else 'inline', context)
        return body, context, placement(screen) == 'dock'

    def head(self, body, snippet, context):
        """The row that heads `snippet`: its number, its title and when it changed."""
        head = next((row for row in body if row.startswith(f"#{snippet['id']} ")), None)
        self.assertIsNotNone(head, f"#{snippet['id']} has no head\n" + context)
        return head

    def assert_shows(self, body, snippet, buttons, context):
        head = self.head(body, snippet, context)
        # When it changed stays whole beside the title, which gives way first.
        self.assertTrue(head.endswith(f'  {changed(snippet)}'), f"#{snippet['id']}'s head cut when it changed\n" + context)
        title = re.split(r' {2,}', head)[0]
        # One row: the title is cut where it ends, never wrapped onto the body.
        self.assertTrue(f"#{snippet['id']} {snippet['title']}".startswith(title.rstrip('…')), context)
        rows = [row.strip() for row in body[body.index(head) + 1 :]]
        end = next((i for i, row in enumerate(rows) if row.split() == buttons), None)
        self.assertIsNotNone(end, f"#{snippet['id']}'s {' '.join(buttons)} row is missing\n" + context)
        for line in snippet['body'].split('\n'):
            self.assertIn(line, rows[:end], f"#{snippet['id']}'s body line {line!r} is missing\n" + context)

    def assert_fits(self, body, context, docked):
        # The last card's buttons end what is drawn, a blank row under them:
        # none cut off below. Framed, that row ends the pane, none asked for
        # and left empty; docked, the pane runs on to the screen's bottom.
        rows = [row.strip() for row in body]
        last = max(i for i, row in enumerate(rows) if row)
        self.assertEqual(rows[last].split()[-2:], ['Copy', 'Remove'], 'the last card is cut off\n' + context)
        self.assertGreater(len(rows), last + 1, context)
        if not docked:
            self.assertEqual(len(rows), last + 2, 'a row asked for and left empty\n' + context)

    def test_slash_longterm_shows_earlier_sessions_snippets_whole(self):
        for columns in WIDTHS:
            with self.subTest(columns=columns):
                body, context, docked = self.draw([PLAN, CHECKLIST], columns)

                self.assertIn('Hide earlier sessions', [row.strip() for row in body], context)
                self.assert_shows(body, PLAN, EARLIER_BUTTONS, context)
                self.assert_shows(body, CHECKLIST, EARLIER_BUTTONS, context)
                self.assert_fits(body, context, docked)

    def test_this_sessions_snippets_open_the_pane_as_the_session_starts(self):
        for columns in (w for w in WIDTHS if w >= UNASKED_FROM):
            with self.subTest(columns=columns):
                body, context, docked = self.draw([{**PLAN, 'isMine': True}, CHECKLIST], columns, asked=False)

                self.assert_shows(body, PLAN, BUTTONS, context)
                self.assertIn('Earlier sessions: 1 snippet', [row.strip() for row in body], context)
                self.assertNotIn('#2 Preprod checklist', '\n'.join(body), context)

    def test_a_long_title_is_cut_to_its_row(self):
        for columns in WIDTHS:
            with self.subTest(columns=columns):
                body, context, docked = self.draw([{**LONG, 'isMine': True}, {**JAPANESE, 'isMine': True}], columns)

                self.assert_shows(body, LONG, BUTTONS, context)
                self.assert_shows(body, JAPANESE, BUTTONS, context)
                self.assert_fits(body, context, docked)

    def test_a_narrow_terminal_says_where_this_sessions_snippets_are(self):
        # Opened unasked below 144 columns, the pane waits undrawn: a toast names /longterm.
        for columns in (60, UNASKED_FROM - 1):
            with self.subTest(columns=columns):
                claude = Claude(ROOT)
                try:
                    claude.seed([{**PLAN, 'isMine': True}])
                    screen = claude.started(columns, HEIGHT, lambda s: '/longterm' in s, name=f'{self._testMethodName}-{columns}')
                finally:
                    claude.close()

                self.assertEqual(toast_body(screen), 'longterm This session: 1 snippet · /longterm', screen)

    def test_the_body_draws_as_markdown(self):
        for columns in (60, 200):
            with self.subTest(columns=columns):
                body, context, _ = self.draw([{**MARKDOWN, 'isMine': True}], columns)
                rows = [row.strip() for row in body]

                self.assertIn('Fixed the --force flag.', rows, context)
                self.assertIn('- One', rows, context)
                self.assertIn('- Two', rows, context)


if __name__ == '__main__':
    unittest.main(verbosity=2)
