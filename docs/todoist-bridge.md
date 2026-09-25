# Todoist bridge (advanced)

The bridge is a YAML package that talks to the Todoist API v1 directly. Use it if you want **real Todoist sections grouped in the card** and **Todoist's own Quick Add parser** today.

> [!TIP]
> **There's now a simpler way.** The [companion integration](https://github.com/joshmd/natural-language-todo-companion) gives you the same grouped sections and Quick Add parsing, set up in **Settings → Devices & services**. It reuses your Todoist integration's connection and only syncs the projects you tick. The bridge keeps working, but new setups should use the companion. See [moving to the companion](#moving-to-the-companion-integration).

If you only need to add items to Todoist and tick them off, you don't need the bridge: use your existing Todoist integration instead. See [Setup 2 in the README](../README.md#setup-2-todoist-with-your-existing-integration).

## Requirements

- The card, installed as described in the [README](../README.md#install-the-card)
- A Todoist API token: Todoist → **Settings** → **Integrations** → **Developer** → **Copy API token**

## Step 1: Install the bridge package

You need to edit files in your `/config` folder. The **File editor** or **Studio Code Server** add-on works, or you can use Samba or SSH.

1. **Turn on packages.** If `configuration.yaml` doesn't already have this, add it:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

   If you already have a `homeassistant:` section, add the `packages:` line inside it rather than creating a second one.

2. **Copy the package.** Download [`packages/todoist_bridge.yaml`](../packages/todoist_bridge.yaml) and save it as `/config/packages/todoist_bridge.yaml`. Create the `packages` folder if it doesn't exist.

3. **Add your token.** Add this line to `/config/secrets.yaml`, replacing the example with your own token. Keep the word `Bearer ` and the space after it:

   ```yaml
   todoist_auth: "Bearer 0123456789abcdef0123456789abcdef01234567"
   ```

4. **Keep the task list out of the history database.** The sensors hold every task as attributes. Add this to `configuration.yaml`, or merge it into your existing `recorder:` section:

   ```yaml
   recorder:
     exclude:
       entities:
         - sensor.todoist_tasks
         - sensor.todoist_sections
         - sensor.todoist_completed
   ```

5. **Restart.** Go to **Developer tools** → **YAML** → **Check configuration**. If it passes, restart Home Assistant.

6. **Check it works.** In **Developer tools** → **States**, find `sensor.todoist_tasks`. Its state should be a number, and it should have a `results` attribute.

If you never want to show completed items, you can delete the third `rest:` block (`Todoist Completed`) from the package.

## Step 2: Find your project ID

Open the project in the Todoist web app. The ID is the last part of the address, after the final hyphen:

```
https://app.todoist.com/app/project/shopping-6Jf8VQXxpwv59GRH
                                             ^^^^^^^^^^^^^^^^
```

You can also find `project_id` in any entry of the `results` attribute of `sensor.todoist_sections`.

## Step 3: Add the card to a dashboard

Edit a dashboard, select **Add card**, search for **Natural Language To-do Card**, then switch to the code editor and set your `project_id`:

```yaml
type: custom:natural-language-todo-card
title: Shopping
project_id: 6Jf8VQXxpwv59GRH
count_suffix: to get
show_completed: true
hide_sections:
  - Online
collapsed_sections:
  - Household
add_timeout: 20
```

## Privacy and security

Please read this before you install.

- **Your token stays on your server.** It lives in `secrets.yaml` and is only sent to `api.todoist.com`. The card never sees it.
- **Every Home Assistant user can read the task list.** By default the sensors hold tasks from **every project in your Todoist account**, including shared projects. Every Home Assistant user can read them, and so can any app, token or AI assistant with read access to Home Assistant.
- **Every Home Assistant user can change tasks.** Anyone with a Home Assistant login can add, complete and reopen tasks through the bridge.
- **Other Todoist endpoints are blocked.** The bridge only accepts well-formed Todoist IDs and strips anything else from its URLs, so no call can reach another part of the Todoist API. It cannot delete tasks or projects.
- **Don't expose these sensors to voice assistants.** Go to **Settings** → **Voice assistants** → **Expose** and make sure the three `sensor.todoist_*` entities are not exposed to Assist or other voice assistants.

### Optional: only sync one project

To keep other projects out of Home Assistant entirely, add `&project_id=YOUR_PROJECT_ID` to the end of the first two `resource:` URLs in the package:

```yaml
  - resource: https://api.todoist.com/api/v1/tasks?limit=200&project_id=6Jf8VQXxpwv59GRH
  ...
  - resource: https://api.todoist.com/api/v1/sections?limit=200&project_id=6Jf8VQXxpwv59GRH
```

This also raises the 200-task limit to 200 tasks **per project**. In this mode every card must use that same project.

### Optional: limit the scripts to certain projects

Both scripts in the package start with `allowed_projects: []`. List the project IDs your cards use, in both scripts:

```yaml
      - variables:
          allowed_projects: ["6Jf8VQXxpwv59GRH"]
```

The card's scripts then refuse to add to, complete or reopen tasks in any other project. This protects against mistakes and casual misuse. It does not stop a determined Home Assistant user, who can call the underlying `rest_command` actions directly.

## Bridge-only options

| Option | Default | Description |
|---|---|---|
| `project_id` | **required** | Todoist project ID |
| `tasks_entity` | `sensor.todoist_tasks` | Change this if you renamed the sensors |
| `sections_entity` | `sensor.todoist_sections` | |
| `completed_entity` | `sensor.todoist_completed` | |
| `add_script` | `script.todoist_bridge_add` | |
| `done_script` | `script.todoist_bridge_set_done` | |

With the bridge, everything after `/Section` handling is Todoist's own Quick Add parser, so `every 2 months`, `@labels` and `p1` all work. Todoist's parser is eager: `sun cream` becomes an item called "cream" due on Sunday. Rephrase it (`suncream`) or fix the date in Todoist.

## Bridge limits

- Up to 200 active tasks and 200 sections are fetched, across your whole account (or per project in single-project mode). There is no pagination.
- Completed items cover the last 7 days.
- Changes made in the Todoist app appear within 60 seconds. Changes made in the card appear immediately.
- Subtasks are shown flat within their section.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Card says `sensor.todoist_tasks is missing` | The package isn't loaded. Check that `packages:` is in `configuration.yaml`, the file is in `/config/packages/`, and you restarted. |
| `sensor.todoist_tasks` is `unavailable` | Check your token in `secrets.yaml`, including the `Bearer ` prefix. Look in **Settings** → **System** → **Logs** for `rest` errors. |
| "Custom element doesn't exist" | Reload the browser. With a manual install, check the resource URL and type. |
| Items are added but don't land in the right list | Check that `project_id` in the card matches the Todoist address. |

## Moving to the companion integration

Your cards don't need to change: a card with `project_id` and no `source` uses the companion automatically once it's installed.

1. Install the [companion integration](https://github.com/joshmd/natural-language-todo-companion), restart, and set it up, ticking the same projects your cards use.
2. Reload your dashboard and check the cards still show your lists.
3. Remove the bridge:
   - Delete `/config/packages/todoist_bridge.yaml`.
   - Remove the `todoist_auth` line from `secrets.yaml`.
   - Remove the three `sensor.todoist_*` lines from `recorder: exclude:`.
4. Restart Home Assistant.

If you'd rather be explicit, add `source: companion` to each card.
