# Natural Language To-do Card

[![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=joshmd&repository=natural-language-Todo&category=plugin)
[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories/)
[![Validate](https://github.com/joshmd/natural-language-Todo/actions/workflows/validate.yml/badge.svg)](https://github.com/joshmd/natural-language-Todo/actions/workflows/validate.yml)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000000)](https://www.buymeacoffee.com/joshmd)

A Home Assistant dashboard card for your to-do lists that:

- adds items the way you'd say them: `milk tomorrow 5pm /Bakery`
- groups items into **sections** you can collapse or hide
- keeps the add bar tucked away until you need it
- can show recently **completed** items

It works with **any Home Assistant to-do list**: Local To-do, Todoist, Google Tasks, CalDAV, the Shopping list and others.

<img src="images/screenshot.png" alt="The card showing a Shopping list grouped into Fruit & veg, Bakery and Household sections, with due-date chips and a Completed group" width="400">

## Choose your setup

| Setup | What you need | Sections | Understands |
|---|---|---|---|
| **[1. Any to-do list](#setup-1-any-to-do-list)** | Just this card | Show several lists in one card, one section each | Dates and times, if the list supports them |
| **[2. Todoist, with your existing integration](#setup-2-todoist-with-your-existing-integration)** | This card and the core [Todoist integration](https://www.home-assistant.io/integrations/todoist/) | Add into a Todoist section with `/Section`. Items are not grouped by section | Dates, times, repeats (`every 2 months`), `@labels`, `p1`–`p4` |
| **[3. Todoist bridge](docs/todoist-bridge.md)** (advanced) | This card and a YAML package with your Todoist API token | Real Todoist sections, grouped | Todoist's own Quick Add parser |

Setups 1 and 2 need **no YAML and no API token**. The card uses Home Assistant's own to-do lists and actions.

A companion integration is planned that adds grouped Todoist sections to setup 2, set up entirely in **Settings → Devices & services**.

## Requirements

- Home Assistant **2024.8** or newer
- [HACS](https://hacs.xyz), unless you install manually

---

## Install the card

1. Click this button to open the repository in HACS:

   [![Open your Home Assistant instance and open this repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=joshmd&repository=natural-language-Todo&category=plugin)

   <details>
   <summary>If the button does not work</summary>

   1. Open **HACS** in Home Assistant.
   2. Select the three-dot menu (top right) → **Custom repositories**.
   3. Repository: `https://github.com/joshmd/natural-language-Todo`
   4. Type: **Dashboard**
   5. Select **Add**, then search HACS for **Natural Language To-do Card**.

   </details>

2. Select **Download**, then **Download** again to confirm.
3. When HACS asks, reload your browser.

HACS registers the dashboard resource for you.

<details>
<summary>Install the card manually instead</summary>

1. Download `natural-language-todo-card.js` from the [latest release](https://github.com/joshmd/natural-language-Todo/releases/latest).
2. Copy it to `/config/www/natural-language-todo-card.js`.
3. Go to **Settings** → **Dashboards** → three-dot menu → **Resources** → **Add resource**:
   - URL: `/local/natural-language-todo-card.js?v=0.2.0`
   - Resource type: **JavaScript module**
4. Reload your browser. Change the `?v=` number whenever you update the file, or browsers keep using the old copy.

If you don't see **Resources**, turn on **Advanced mode** in your user profile.

</details>

---

## Setup 1: Any to-do list

1. Edit a dashboard and select **Add card**.
2. Search for **Natural Language To-do Card**. It starts with your first to-do list.
3. Switch to the code editor to choose a different list or change options:

```yaml
type: custom:natural-language-todo-card
entity: todo.shopping_list
title: Shopping
```

Don't have a list yet? Add the **Local To-do** integration in **Settings → Devices & services** to create one.

### Several lists as sections

List more than one to-do list and each becomes a section of the card. Type `/` and a list's name to add to that list. Without one, items go to the first list.

```yaml
type: custom:natural-language-todo-card
title: Shopping
entities:
  - todo.fruit_and_veg
  - todo.bakery
  - entity: todo.household
    name: Around the house   # optional: rename the section
```

`bread tomorrow /Bakery` adds "bread" to the Bakery list, due tomorrow.

### What the card understands

The card works dates out itself, and only when the list can store them. A list without due dates keeps what you typed as it is. The preview under the box shows exactly what will be saved before you press Enter.

| You type | Due |
|---|---|
| `today`, `tonight`, `tomorrow` | That day |
| `friday`, `on monday` | The next one (today, if it's that day) |
| `next friday`, `next week` | Friday or Monday of next week |
| `weekend` | The coming Saturday |
| `in 3 days`, `in two weeks`, `in a month` | That far ahead |
| `25 dec`, `December 25th`, `3 march 2027`, `2026-12-25` | That date. Past dates without a year mean next year |
| `25/12` | Day/month or month/day, following your Home Assistant date format |
| `5pm`, `5:30pm`, `17:45`, `at noon` | That time, if the list supports times. A time on its own means today, or tomorrow if it has passed |

To avoid mistakes:

- **Short day names only count at the end:** `bin bags fri` is due Friday, but `sun cream` and `sat nav` stay as they are. The same goes for `25/12`, so `flour 1/2 kg` is left alone.
- **Quotes switch parsing off:** `"back to the future" friday` adds "back to the future", due Friday.
- **Repeats aren't supported** in Home Assistant's own lists. `every monday` stays in the text, and the preview says so. Use setup 2 or 3 with Todoist for repeating items.

The words are English. Date and time display follows your Home Assistant language.

---

## Setup 2: Todoist, with your existing integration

If you already use the core [Todoist integration](https://www.home-assistant.io/integrations/todoist/), each Todoist project is already a to-do list in Home Assistant. Point the card at one:

```yaml
type: custom:natural-language-todo-card
entity: todo.weekly_food_shop
title: Food shop
```

The card spots that the list comes from Todoist and adds items through the integration's `todoist.new_task` action, so **Todoist parses the date**. On top of everything in setup 1, you can use:

| You type | Result |
|---|---|
| `/Bakery` | Adds to the Bakery section. For a name with spaces, use quotes: `/"Corner shop"` |
| `every 2 months`, `every monday`, `daily` | A repeating task |
| `@home` | Adds the label "home" |
| `p1` to `p4` | Priority, as in the Todoist app |

Things to know:

- **Sections aren't shown as groups.** The Todoist integration doesn't tell Home Assistant which section a task is in, so the list shows ungrouped. The companion integration will fix this, or use [setup 3](docs/todoist-bridge.md) today.
- **The card can't check section names.** The preview marks them "checked by Todoist". If the section doesn't exist, Todoist rejects the item, the card shows the error and your text is kept.
- **New items take a moment to show up.** The card shows them straight away, and the Todoist integration confirms them on its next refresh.
- **Completed items aren't available.** The Todoist integration only provides open tasks.
- **Renamed lists:** the card finds the Todoist project by the list's name. If you've renamed the list in Home Assistant, set `todoist_project:` to the project's name in Todoist.

---

## Options

| Option | Default | Description |
|---|---|---|
| `entity` | | The to-do list to show (setups 1 and 2) |
| `entities` | | Several lists, one section each. Each entry is an entity ID, or `entity:` plus an optional `name:` |
| `title` | none | Card heading |
| `show_completed` | `false` | Show a Completed group, if the list keeps completed items |
| `completed_limit` | `10` | Maximum completed items shown |
| `completed_collapsed` | `true` | Completed group starts collapsed |
| `hide_sections` | `[]` | Sections to hide, by name or ID. Their items are hidden too |
| `collapsed_sections` | `[]` | Sections collapsed until someone expands them |
| `hide_empty_sections` | `true` | Hide sections with no open items |
| `show_unsectioned` | `true` | Show items that are not in a section |
| `unsectioned_title` | none | Give unsectioned items a header. Without one, they sit at the top |
| `due_display` | `all` | `all`, `soon` (overdue, today, tomorrow) or `none` |
| `parse_dates` | `true` | Set to `false` to keep everything you type as the item text |
| `todoist_project` | list name | Setup 2 only: the Todoist project name, if it differs from the list's name |
| `add_timeout` | `20` | Seconds of no typing before the add bar closes. `0` = never |
| `show_count` | `true` | Show the open-item count in the header |
| `count_suffix` | `open` | Text after the count, for example `to get` |
| `show_hint` | `true` | Show the example under the add field |
| `accent` | theme accent | Any CSS colour for the + button, ticks and today chips |
| `source` | `auto` | `todo` or `todoist_bridge`. Normally worked out from the other options |

The Todoist bridge has a few extra options, listed in [its guide](docs/todoist-bridge.md#bridge-only-options).

Collapsed and expanded sections are remembered per device. The card's earlier name, `custom:todoist-sections-card`, still works.

## Using the add bar

- **Saving:** Enter or the tick saves. The bar stays open for the next item.
- **Closing:** the bar closes after `add_timeout` seconds of no typing and keeps any half-typed text. × or Escape closes it and clears the text.
- **Preview:** before you save, the card shows the list or section, due date, repeat, labels and priority it has picked out.
- **Confirmation:** after saving, the card says what it added, for example "Added milk to Bakery, due Tomorrow 17:00".

## Privacy and security

- **Setups 1 and 2 add nothing new to Home Assistant.** The card uses the to-do lists and actions Home Assistant already has, with your normal login. It has no API token and talks to no outside service.
- **Home Assistant users can change lists.** Anyone with a Home Assistant login can add and tick items on lists they can see. That's how Home Assistant's to-do lists already work, with or without this card.
- **The Todoist bridge is different.** It stores an API token and syncs your Todoist account into Home Assistant. Read [its privacy notes](docs/todoist-bridge.md#privacy-and-security) before using it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "todo.… was not found" | Check the entity ID in **Settings → Devices & services → Entities**. |
| No + button | The list doesn't allow adding items. Some integrations provide read-only lists. |
| Dates stay in the item text | The list doesn't support due dates, or the phrase isn't one the card knows. The preview shows what it understood. |
| Todoist: an error about the section | That section doesn't exist in the Todoist project. Check the spelling, or use quotes for names with spaces. |
| Todoist: an error about the project name | You've renamed the list in Home Assistant. Set `todoist_project:` to the name used in Todoist. |
| "Custom element doesn't exist" | Reload the browser. With a manual install, check the resource URL and type. |

## Licence

[MIT](LICENSE)

## Support

If this card is useful to you, you can buy me a coffee:

<a href="https://www.buymeacoffee.com/joshmd"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=&slug=joshmd&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy me a coffee" height="50"></a>
