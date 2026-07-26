# The Bell

An activity feed inside Twenty. A bell button in the top-right corner opens a side panel showing what happened in the CRM, what your team is talking about, and what is overdue on you personally.

Русская версия: [README.ru.md](https://github.com/frasimah/twenty_bells/blob/main/README.ru.md).

## What it does

- **Change feed.** Records created and edited, read from the standard `timelineActivity` — custom objects included. Field changes render as a diff, and `SELECT` values keep the same coloured labels the record page uses.
- **Documents.** Twenty emits no timeline event for an attachment, so the panel reads files separately and files each one into the card of the record it hangs on — a deal, a contact, a custom object. Clicking the file name opens the attachment; clicking anywhere else on the card opens the record.
- **Buzz.** Team notes as posts with their comments underneath. Twenty has no comment object — amending a note's body is the mechanism — so each thread is reconstructed from the `note.updated` diffs, and every reply says who wrote it and when.
- **Tasks.** Overdue first, oldest first, then everything else by due date. Done tasks are dropped. If a task belongs to a deal, the deal is on the row. The badge counts what is assigned to you and not done — asked of the server, so it is the real number rather than the length of the loaded page.
- **Grouping.** Several events on one record collapse into a single line with a counter that expands in place. A burst of identical events — an import, a bulk edit — becomes one row like `29 × document · added`.
- **Read / unread.** The marker is personal, stored per `userId` in the app's own object.
- **Opens the record.** A click opens the object in Twenty's side panel without leaving the page.

## What it costs to keep open

Nothing at all until the bell is clicked. The panel is a side panel and Twenty loads it on demand — the renderer is not even fetched before that, and closing the panel unmounts the whole thing.

Open, it polls once a minute, and every tick asks one cheap question first: the id of the newest event and the size of the window, one row without relations, about 2 KB. Unchanged means the tab already holds the truth and nothing else is fetched. Five minutes without a click, a keypress or a scroll inside the panel and it stops asking altogether, saying so in a line at the top; the next touch resumes it and refreshes at once.

On a workspace of some 1,800 tasks and as many notes that comes to roughly 10 KB a minute while somebody is actually reading it.

The trade is latency: a new event surfaces within a minute rather than instantly.

## Requirements

- Twenty server **2.23.0 or later** (declared as `engines.twenty`)
- Node 24 and Yarn 4 for local development

## Install into your Twenty

```bash
git clone https://github.com/frasimah/twenty_bells.git
cd twenty_bells
corepack enable
yarn install
```

You need an API key for the target instance: in Twenty open **Settings → APIs → Create API key** and copy the value — it is shown once.

```bash
yarn twenty remote:add --as my-crm --url https://your-twenty-server.com --api-key <YOUR_KEY>
yarn twenty remote:use my-crm
yarn twenty apply
```

`--url` is the **server** address, not the frontend, if the two are on different ports. The key is stored in `~/.twenty/config.json` and never reaches the repository.

`apply` prints the plan first, then syncs the application, its role, the technical `feedReadState` object, the front component and the command-menu button. Reload the CRM tab afterwards — the bell appears in the top-right corner.

No instance of your own? `yarn twenty docker:start` brings one up on `http://localhost:2020` (`tim@apple.dev` / `tim@apple.dev`), and `remote:add --local` finds it by itself.

Updating after a `git pull` is the same `yarn twenty apply`. To remove the app, `yarn twenty app:uninstall`.

## Permissions

The panel calls the API under the **application's** role, not under the permissions of the person who opened it. So:

- on the **Organization** plan row-level permissions apply — Twenty scopes the data itself and the panel adds no filtering of its own;
- on other plans the predicates sync but stay inert, and the panel filters client-side: by deal owner, company account owner and task assignee.

Which mode is live is detected at runtime: the panel asks the server for records it should have withheld and reads the answer. When Twenty does the scoping itself, the header carries an **Access: server** badge; otherwise the panel filters on its own and says nothing.

**The client-side filter is not a security boundary.** Until row-level permissions are enforced, the server hands the whole workspace to the browser. Install the app where that is acceptable.

## Settings

The app deliberately ships **no Settings tab**. What would be there — poll interval, page size — lives in `src/front-components/activity-feed.tsx` as constants; change one and run `yarn twenty apply`.

> The reason is not minimalism. The host injects application-variable values into a front component still **encrypted** — `enc:v2:<workspace>:<blob>` — and neither `twenty-sdk` nor `twenty-client-sdk` decrypts them. Verified by printing the raw payload inside the panel: `getApplicationVariable('SHOW_ATTACHMENTS')` returned the ciphertext, not `true`, and the panel read it as "off" and hid every file. Switches an admin can move that change nothing are worse than no switches, so they are gone until Twenty decrypts them.
>
> This cannot be diagnosed from outside either: the metadata API refuses to read the values back — an API key gets `Cannot return null for non-nullable field Application.applicationVariables`, the application token is denied by permissions. Writing (`updateOneApplicationVariable`) does work.

Application variables are workspace-wide anyway; the SDK has no per-user ones. Anything personal lives in the app's `feedReadState` object.

## What the feed cannot show

Limits of the source, not of the app:

- **deletions** — Twenty writes no event for them at all;
- **emails and meetings** — `message` and `calendarEvent` have no relation to `timelineActivity`;
- **history of deleted records** — the event survives but its link breaks; those rows are marked "record deleted".

## Development

```bash
yarn lint        # oxlint
yarn typecheck   # tsgo
yarn test:unit   # vitest, no server needed
yarn test        # integration tests against a real instance
```

CI runs all of it on every push against a Twenty instance spawned for the job. CD is manual (`workflow_dispatch`): the scaffold's deploy-on-push targeted `http://localhost:2020`, which from a GitHub runner is the runner itself.

## Publishing

`Publish` (`.github/workflows/publish.yml`) publishes the package to npm with provenance via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), which is also how app ownership is claimed in a Twenty marketplace.

1. On npmjs.com register this repository and `publish.yml` as a trusted publisher of the package.
2. Bump `version` in `package.json`, then push a tag (`git tag v1.0.1 && git push --tags`) or run the workflow from the Actions tab.

npm accepts provenance only from **public** repositories. To publish from a private one, set `TWENTY_APP_PUBLISH_DISABLE_PROVENANCE: 'true'` in the publish step — at the cost of the trust badge and of the marketplace ownership claim.

The marketplace catalog syncs from npm hourly; `yarn twenty dev:catalog-sync` triggers it immediately.

## Learn more

- [Twenty Apps documentation](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [twenty-sdk CLI reference](https://www.npmjs.com/package/twenty-sdk)
- Changes are listed in [CHANGELOG.md](https://github.com/frasimah/twenty_bells/blob/main/CHANGELOG.md).
