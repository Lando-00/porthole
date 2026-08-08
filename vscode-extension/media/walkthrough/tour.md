# Ask, and watch the code

The point of porthole is that an explanation and the code it describes are the
same thing. Try asking your Copilot CLI session:

> **walk me through how this project handles errors**

The agent builds a **tour**: an ordered path through the code, with its
narration in a CodeLens directly above each step.

- `Alt+]` / `Alt+[` — next and previous step
- The **gutter** shows visited, current, and still to come
- The **status bar** shows where you are

Or ask it to *"annotate the lines you're describing"* and the ranges are marked
where it is looking, with the explanation on hover.

---

## Several at once

A pull request rarely has one thread. Ask for the auth path, the error handling
and the migration as **separate tours** — all of them appear in the **Problems**
panel as a map of the change, while you walk one at a time.

Tours are saved into the session folder, so closing the window does not lose
them, and a later session can pick one up. Each step remembers the code it was
written about, so a walkthrough that has gone out of date **says so** rather
than pointing confidently at code that has since changed.

Switching between them, and jumping to a step, is a click in the sidebar.
`/porthole tours` lists what exists — including walkthroughs saved by earlier
sessions, and how much of each still matches the code.
