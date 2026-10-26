# Sequences

A sequence is a series of emails each new subscriber gets on a schedule, like a five-email welcome series over ten days. Each step can have a version per group of readers, chosen by their [contact fields](contact-fields.md): a version per sun sign, and a fallback for everyone else.

## How it works

- **Steps** go in order. Each has a `dayOffset`: days after the contact joined, `0` for right away. Offsets can't go down from one step to the next; decimals work (`0.5` is 12 hours).
- **Variants** are the versions of a step's email: a subject, a preview text and content (`html` by default, or `markdown` or `rich` as in campaigns). A variant's `match` says which contacts it's for, e.g. `{ "sun_sign": "scorpio" }` or `{ "sun_sign": ["leo", "aries"] }`. A variant without `match` is the step's fallback, for contacts no other variant matches; a step has one at most. A contact that matches no variant and has no fallback skips that step and goes on to the next.
- **Who joins**: a contact joins every active sequence of its newsletter when it becomes active. That's at signup (`add_contact`, the archive's form, Add contact on the dashboard), or, when the newsletter asks new subscribers to confirm, when they click the confirmation link. Active contacts who haven't joined (imported ones, those who were there before the sequence was active, or whose signup didn't get them in) join on the cron's next run, from when they confirmed or subscribed: the steps due since go out one per run, spaced like any late step. A contact joins a sequence once, ever.
- **Who stops**: a contact who unsubscribes, bounces, complains or goes dormant leaves the sequence at its next step. A step queued just before they left is dropped when its batch runs.

### Once per step

Each step goes to each contact once. The record of a step for a contact is unique in the database (one message per sequence, step and contact), so two runs at the same time, a retried job or a crash halfway can't send it twice. Sends also claim each message once, as campaigns do.

Replacing a step keeps its ID (`set_sequence_step` at a position, or `update_sequence` with the step's `id`), so contacts who got it don't get it again. Contacts in the sequence go on from the step they're at.

### When steps go out

- The first step, when it's due at once, goes from the signup itself, like a welcome email.
- A cron calls `/api/cron/sequences` every 15 minutes: it takes in active contacts who haven't joined, brings back a `nextAt` set later than its step is due, and queues every step that came due, as send batches through QStash, like a campaign's. Self-hosted: see the README's **Sequences** entry under Optional.
- **Quiet hours**: nothing is due between 03:00 and 06:00 Europe/Amsterdam time. A step due then moves to 06:00, and a run in those hours does nothing. Clock changes are taken into account.
- **Late steps keep their spacing**: when a step goes out late (a paused sequence, a blocked account, sending off), the next waits as long after it as their offsets are apart, so steps never arrive together. Steps that shouldn't go late can be skipped instead: see [Late and time-limited steps](#late-and-time-limited-steps).
- **Limits**: steps count toward the plan's emails like welcome emails. Once the month's emails are used up they're skipped, not sent later, and the owner hears once a month. On MailCheap Cloud a run sends what the account's warm-up pace allows at full speed, 50 at least, and leaves the rest for the next run. A blocked account or one without a plan sends nothing; its steps wait.
- **Pausing** (`update_sequence` with `"status": "paused"`) holds every contact where they are and takes nobody new. Making it active again sends the steps that came due since, spaced out.

### Late and time-limited steps

By default a step goes however late it is. Three settings change that, each left out unless set:

- **`lateLimitHours`** (a step's, 1 to 8760): a contact the step reaches more than that many hours after it was due skips it. Due is when the step would have gone: its `dayOffset` after joining, or later to keep its spacing after the step before.
- **`skipAfterField`** (a step's): the name of a custom field holding the contact's own deadline, as unix seconds (`1798761600`) or an ISO 8601 date (`2026-12-31T23:00:00Z`). A contact whose time has passed when the step is due skips it. A contact without the field, or with a value that isn't one of those, gets the step as usual.
- **`minHoursBetweenSteps`** (the sequence's, 0 to 168, 0 by default): a contact's steps are at least that many hours apart, even when their offsets are closer or the step before went late. It counts from the step before, so a change applies from each contact's next step on.

A skipped step sends nothing and the contact goes on to the next. When that one is due already, the same run looks at it too: after a long stop, a contact skips every step that's too late and gets the first one that isn't, one email per run at most. Skipping the last step completes the sequence. A step already queued for a contact when a run stopped halfway still goes, however late. Each contact's skipped steps are counted on its place in the sequence (`skippedSteps`), and each run reports how many it skipped.

A day-5 offer that ends 24 hours after it's sent, for contacts whose quiz sets `offer_expires_ts`, with at least a day between any two emails:

```json
{
  "name": "Welcome series",
  "minHoursBetweenSteps": 24,
  "steps": [
    { "dayOffset": 0, "variants": [{ "subject": "Welcome, {{first_name|friend}}", "content": "<html>…</html>" }] },
    { "dayOffset": 2, "variants": [{ "subject": "What your sign describes", "content": "<html>…</html>" }] },
    {
      "dayOffset": 5,
      "lateLimitHours": 24,
      "skipAfterField": "offer_expires_ts",
      "variants": [{ "subject": "Your personal offer ends at {{offer_ends}}", "content": "<html>…</html>" }]
    }
  ]
}
```

If sending stops on day 4 and starts again on day 7, the offer step is more than 24 hours late and nobody gets it; a contact whose `offer_expires_ts` passed on day 5 skips it even when everything runs on time.

`set_sequence_step` and `update_sequence` replace a step with what they're sent: send `lateLimitHours` and `skipAfterField` again to keep them. `scripts/import-sequence.mjs --sequence` keeps the ones the steps already have.

## API and MCP

Every action is a REST endpoint under `/api/v1` and an MCP tool with the same name.

| Action | REST | What it does |
|---|---|---|
| `list_sequences` | `GET /sequences` | Sequences with their steps and variants, without content |
| `get_sequence` | `GET /sequences/{id}` | One sequence, each step's queued, sent, opened and clicked emails, contacts in it. `includeContent=true` adds the content |
| `create_sequence` | `POST /sequences` | A draft, with or without steps |
| `set_sequence_step` | `POST /sequences/{id}/steps` | Adds a step at the end, or replaces the one at `position` |
| `update_sequence` | `PATCH /sequences/{id}` | Name, all steps, or `status`: `active` or `paused` |
| `delete_sequence` | `DELETE /sequences/{id}` | Deletes it and who's in it; steps queued and not sent don't go |

Making a sequence active checks every variant like a send: the newsletter's from address and postal address, a subject, content, and Gmail's 100 KB clip. From then on, new subscribers join, and the cron's next run takes in the newsletter's active contacts already there.

```bash
curl -X POST https://mail.example.com/api/v1/sequences \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Welcome series","newsletter":"my-newsletter"}'

curl -X POST https://mail.example.com/api/v1/sequences/$ID/steps \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" -H "Content-Type: application/json" \
  -d '{"position":1,"dayOffset":0,"variants":[
        {"match":{"sun_sign":"scorpio"},"subject":"Scorpio, welcome","content":"<html>…</html>"},
        {"subject":"Welcome, {{first_name|friend}}","content":"<html>…</html>"}]}'

curl -X PATCH https://mail.example.com/api/v1/sequences/$ID \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"active"}'
```

## Loading a 5-step welcome series with 12 sign variants

`scripts/import-sequence.mjs` loads a folder of HTML emails into a sequence, one API call per step.

### The folder

One file per step and variant, named `<anything>-<step>-<variant>.html`:

```
varianten/
  welcome-01-aries.html … welcome-01-pisces.html     step 1, one per sign
  welcome-02-aries.html … welcome-02-pisces.html     step 2
  …
  welcome-05-pisces.html                             step 5
  welcome-02-default.html                            optional: step 2's fallback
```

- The step number orders the steps: 1, 2, 3… without gaps.
- The variant is the value of the matched field, `sun_sign` by default (`--field` for another). `default`, `fallback` or `all` makes the file the step's fallback.
- Each file has a comment with its day, subject and preview text, as the Stellara drafts do. The script takes them from there and leaves the comment out of the email (`--keep-comments` keeps it):

```html
<!-- Stellara welcome mail 2 of 5 …
     Send: day 1 after opt-in. Subject: Scorpio: what your Sun sign describes, and what it leaves out
     Preview text: A pattern, not a verdict. Plus the number inside your birth date. -->
```

  Without `Send: day N`, pass the days: `--days 0,1,3,6,9`.
- Keep `{{unsubscribe_url}}` in each file's own footer, with the postal address, or MailCheap adds its footer.
- Merge tags work in the files: `Hello {{first_name|there}},` instead of a fixed `Hello,`.

### Steps

1. Make sure new contacts get their fields: the quiz or form sends `fields` with `add_contact`, at least `sun_sign`, and `first_name` and `life_path` when known.
2. Check the folder without calling anything:

   ```bash
   node scripts/import-sequence.mjs /path/to/welcome/varianten --name "Welcome series" --dry-run
   ```

   It prints each step's day, variants and subject, and warns about placeholders left in the HTML (`[[…]]`, `PLACEHOLDER`), files without `{{unsubscribe_url}}`, files close to 100 KB, and steps without a fallback: contacts without a `sun_sign` skip those steps. Add `welcome-0N-default.html` files for them.
3. Load it as a draft, with a full access API key from the API keys page:

   ```bash
   MAILCHEAP_URL=https://mail.example.com MAILCHEAP_API_KEY=... \
     node scripts/import-sequence.mjs /path/to/welcome/varianten --name "Welcome series" --newsletter my-newsletter
   ```

4. Look it over: `GET /api/v1/sequences/{id}?includeContent=true`, or `get_sequence` in an agent. Send yourself a campaign with a variant's HTML to see it in an inbox.
5. Turn off the newsletter's own welcome email if step 1 replaces it, so new subscribers don't get two. With confirmation on, the confirmation email still goes first, and step 1 follows the click.
6. Make it active: run the script again with `--activate`, or `PATCH /api/v1/sequences/{id}` with `{"status":"active"}`.

To change the emails later, run the script with `--sequence <id>` instead of `--name`: each step is replaced in place and keeps its ID, so nobody gets a step twice.

## What it doesn't do yet

- No dashboard pages: sequences are managed through the API, MCP and the script.
- Contacts already on the list, imported ones included, join a sequence made active later, dated from when they subscribed: a sequence without fallback variants skips those whose fields match none.
- A step skipped for want of room in the month isn't sent later.
- One fixed quiet window (03:00 to 06:00 Amsterdam) for every contact, not each reader's own time zone.
- No test email per variant: send yourself a campaign with its content.
