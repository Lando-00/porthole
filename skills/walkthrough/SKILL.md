---
name: walkthrough
description: >-
    Build a narrated, steppable walkthrough of code in the user's VS Code window.
    Use when the user runs /walkthrough.
user-invocable: true
disable-model-invocation: true
metadata:
  author: Lando-00
  version: 0.1.0
---

# Walk the user through code, in their editor

Build **one** walkthrough of whatever the user asked about, push it to their VS
Code window, and let them walk it at their own pace while you stay here for
follow-up questions.

Use the `porthole_tour` tool. Pass `openIfClosed: true` — the user asked for this,
so opening a window is authorised. That flag is why this command works when no
editor is running, and you should not set it anywhere else.

## The flow

**1. Know what you are walking through.**

If the user typed `/walkthrough` with nothing after it, name what you think they
mean from what you have been discussing, in one line, and get on with it:

> Walking you through how a request reaches the editor — say if you meant
> something else.

Do not interrogate them when the subject is obvious. Do not silently guess when
it is not; ask a single question instead.

**2. Read before you write.**

Look at the code properly first. A walkthrough built from a guess is worse than
prose, because it points at specific lines with authority.

Call `porthole_tours` first. If a walkthrough of this already exists, extend or
replace it rather than adding a near-duplicate, and say which you did.

**3. Build one walkthrough, then hand over.**

One walkthrough per invocation. Tell the user it is waiting in VS Code, how to
step through it, and that they can ask you about any step here.

Then **stop**. Do not narrate the tour again in chat. The whole point is that the
explanation is attached to the code, not repeated beside it.

## What the user sees

Each step highlights a range, with your narration in a CodeLens directly above
it and Next/Prev controls to move. The walkthrough also appears in the Problems
panel and in the porthole sidebar, where switching and jumping is a click.

If no window is running, one is opened for them and the walkthrough is delivered
there. That can take a few seconds. If it is reported as not delivered, say so
plainly — never tell the user to look at something that may not have arrived.

## Choosing the steps

A step is a place worth **stopping**, not every place the subject is mentioned.

- Start where the user's question starts. End where it is answered.
- Order the steps the way you would narrate them out loud, which is usually the
  order control actually flows — not file order, not alphabetical.
- Give enough at each stop that they never have to ask "why does that matter".
  A step that only says what the line does has wasted the stop.
- Include the step that explains **why**, even when no single line is
  interesting. The turn nobody can find is usually the important one.
- If the answer has several independent threads, walk the one they asked about
  and offer the others. Do not weld four answers into one walkthrough.

Skip generated files, lockfiles, and vendored code unless they are genuinely the
answer.

## Writing the narration

**Say what is needed to understand this step, then stop.** The user asks if they
want more. Long paragraphs in a two-line lens are cognitive overload, not
thoroughness.

Informed by ASD-STE100 Simplified Technical English:

- Active voice. "This handler validates the token", not "the token is validated".
- One idea per sentence. Short sentences beat one long one with commas.
- One term per thing, used the same way throughout. If the code calls it a
  `session`, call it a session — not a connection, not a context.
- Define a term the first time you use it, in the step where it appears.
- No pronoun whose subject is more than a sentence away. Name the thing again.
- Present tense. Describe what the code does, not what it will do.

Step titles are a few words naming what happens there — "validates the token",
"where the retry starts". Not "Step 3" and not a whole sentence.

Keep the same discipline in your chat replies while this is running. Answer the
question that was asked, at the length it deserves.

## Do not

- Write an essay in chat and attach a walkthrough as decoration.
- Paste the code back at the user. It is already on their screen, marked up.
- Build a walkthrough of code you have not read.
- Tour the lockfile.
- Claim it was delivered when the tool did not confirm it.
