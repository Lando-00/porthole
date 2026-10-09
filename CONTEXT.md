# Porthole

Porthole is the session-aware visual interface between a Copilot CLI session
and VS Code. It makes code explanation interactive while keeping each task's
editor experience isolated from other sessions.

## Language

**Porthole**:
The complete product formed by the CLI plugin and companion.
_Avoid_: Plugin, extension

**CLI plugin**:
The Porthole package installed into Copilot CLI, including skills and its CLI
extension.
_Avoid_: Companion, VS Code extension

**CLI extension**:
The executable part of the CLI plugin that joins a Copilot session and provides
commands, tools, routing policy, and transport participation.
_Avoid_: Companion, CLI plugin

**Companion**:
The Porthole VS Code extension that presents and executes visual interactions
inside one Porthole window.
_Avoid_: CLI extension, plugin

**Copilot session**:
One Copilot CLI conversation and its durable task context. It is the
authoritative identity for Porthole ownership.
_Avoid_: Terminal session, repository session

**Porthole window**:
A VS Code window owned by one exact Copilot session. Ownership is which Copilot
session folder is open in it. Repository identity is context only; a bound
window never owns a second Copilot session.
_Avoid_: VS Code session, shared window

**Primary window**:
The oldest window a Copilot session owns. It is the default target for the
session's interactions and the authoritative participant in a visual broadcast.
_Avoid_: Main window, active window

**Secondary window**:
Any further window the same Copilot session owns, usually one it was explicitly
asked to open. It can receive visual broadcasts or an explicitly targeted Tour;
it does not automatically follow the primary's Walkthrough.
_Avoid_: Duplicate window, extra window

**Tour**:
A durable ordered artifact that powers a Walkthrough.
_Avoid_: Walkthrough, tutorial, trace

**Walkthrough**:
The user experience of following a Tour through code one explanatory stop at a
time.
_Avoid_: Tour

**Tour step**:
One meaningful explanatory stop in a Tour: an anchored code location, title,
and narration.
_Avoid_: File mention, symbol occurrence

**Candidate step**:
A changed code range offered to the model as a possible Tour step. It has a
location in a stated comparison but no narration; the model selects its current
code location before making it part of a Tour.
_Avoid_: Hunk, diff step

**Tour publication**:
The authored explanation and original source evidence of a Tour, established
when it is created or explicitly replaced.
_Avoid_: Autosave, cursor update

**Tour progress**:
The reader's position within one Tour publication, separate from its authored
explanation and evidence.
_Avoid_: Tour revision, publication

**Revision advisory**:
A notice that the repository revision differs from the one recorded for a Tour
publication; it does not assert that the explanation is incorrect.
_Avoid_: Verified explanation, automatic review

**Tour library**:
The collection of tours owned by one Copilot session. A resumed session
restores its library across VS Code closes and CLI restarts; a fork starts with
an empty library.
_Avoid_: Global tour library, shared library

**Active tour**:
The one tour currently driving a particular Porthole window's walkthrough
visuals. Other windows of the same session may walk a different Tour.
_Avoid_: Current walkthrough

**Saved tour discovery**:
An explicit search outside the current Tour Library for tours owned by other
Copilot sessions. Discovered tours never appear in the current library without
a deliberate user action.
_Avoid_: Global library, automatic tour restore

**Imported tour**:
A new tour owned by the current Copilot session and copied deliberately from a
tour owned by another session. It records source provenance but never mutates
the source tour.
_Avoid_: Loaded foreign tour, shared tour

**Tour provenance**:
The source session and source tour from which an Imported Tour was copied.
_Avoid_: Tour owner

**Stale tour step**:
A Tour step whose anchored code changed or is missing. It remains visibly
untrusted until rebuilt; identical code that only moved is not stale.
_Avoid_: Broken tour, updated step

**Close tour**:
Stop walking the Active Tour while retaining it in its owning Tour Library.
_Avoid_: Delete tour, unload tour

**Delete tour**:
Permanently remove a tour owned by the current Copilot session after user
confirmation.
_Avoid_: Close tour, remove tour

**Archive tour**:
Durably hide a tour from its owning Tour Library's default view while keeping
it available through search.
_Avoid_: Unload tour, close tour

**Annotation**:
An ephemeral mark explaining a code range in the current Porthole window. It
becomes durable only when promoted into a Tour or Saved Review.
_Avoid_: Tour step, persistent note

**Saved review**:
A durable set of code findings owned by the Copilot session that created it.
Another session may discover it explicitly and create its own copy with
provenance.
_Avoid_: Global review, shared findings

**Change preview**:
A temporary approval interaction in which the user reviews and may edit
proposed file contents before applying or cancelling them.
_Avoid_: Saved change set, draft patch

**Session artifact**:
A durable Tour or Saved Review whose lifetime and ownership follow one Copilot
session. Longer retention requires deliberate export.
_Avoid_: Global artifact, permanent archive

**Session binding**:
The ownership relationship between one Copilot session and a Porthole window,
established by that session's folder being open in it. A session may hold
several. Clearing it releases the window without deleting the session's Tours or
Saved Reviews.
_Avoid_: Repository match, IDE connection

**CLI endpoint**:
One live Porthole plugin process attached to a Copilot session. It is a
transport participant, not the owner of the session's artifacts.
_Avoid_: Copilot session

**Companion host**:
One live Porthole companion extension host inside a VS Code window. Its address
lasts only for that host lifetime.
_Avoid_: Porthole window, VS Code process

**Disconnected window**:
A Porthole window whose owning Copilot session has no live CLI process. It
retains its binding and Tour Library until that exact session resumes or the
user explicitly clears the binding.
_Avoid_: Unbound window, stale window

**Unbound window**:
A Porthole-capable VS Code window with no Session Binding. It may be adopted
only through an explicit user-directed action.
_Avoid_: Disconnected window, available session

**Connected window**:
A Porthole window whose owning Copilot session has a compatible live CLI
endpoint in the same local environment.
_Avoid_: Active window

**Incompatible window**:
A Porthole window whose plugin and companion lack a capability required for the
requested operation.
_Avoid_: Disconnected window, broken window

**Local environment**:
The shared user-owned filesystem and Copilot home visible to both the CLI
plugin and companion extension host. A connection cannot cross environments
that do not share these files.
_Avoid_: Machine, workspace

**Visual bridge**:
The product boundary through which a Copilot session presents, explains,
reviews, and navigates code in its Porthole window.
_Avoid_: General VS Code automation
