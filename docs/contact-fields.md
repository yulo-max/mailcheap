# Contact fields, merge tags and audiences

Contacts can carry custom fields: a first name, a sun sign, a number, where they came from. Emails print them per reader with merge tags, and a campaign can go only to the contacts whose fields match.

## Fields

A field is a name and a short text value.

- Names: lowercase letters, digits and underscores, starting with a letter, 40 characters at most (`first_name`, `sun_sign`, `ref_code`). MailCheap's own names (`email`, `source`, `status`, `subject`, `preview_text`, `unsubscribe_url`, `confirm_url`, `keep_url`) can't be fields.
- Values: text or a number, 200 characters at most, stored as text. Line breaks become spaces. An empty value or `null` removes the field.
- Up to 30 fields per contact.

Three fields are checked, so audiences and sequence variants can rely on one spelling:

| Field | Values |
|---|---|
| `first_name` | Any text, 100 characters at most |
| `sun_sign` | `aries`, `taurus`, `gemini`, `cancer`, `leo`, `virgo`, `libra`, `scorpio`, `sagittarius`, `capricorn`, `aquarius`, `pisces` (any case in, lowercase stored) |
| `life_path` | `1` to `9`, `11`, `22`, `33` |

A contact's `source` (where they signed up) stays its own property, set by `add_contact` and CSV imports, and merge tags can print it too.

## Setting fields

### REST API and MCP

`add_contact` (`POST /api/v1/contacts`) takes `fields`. They're saved on a new contact, and fill in an existing one when the same address signs up again. Signups only keys can send them, so a website form or quiz can pass what it knows:

```bash
curl -X POST https://mail.example.com/api/v1/contacts \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"mira@example.com","source":"quiz","fields":{"first_name":"Mira","sun_sign":"scorpio","life_path":7}}'
```

`update_contact_fields` (`PATCH /api/v1/contacts/{id}/fields`, the ID or the address) sets or removes fields on an existing contact. Fields left out stay as they are; `null` removes one:

```bash
curl -X PATCH https://mail.example.com/api/v1/contacts/mira@example.com/fields \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"sun_sign":"leo","life_path":null}}'
```

The MCP tools are the same actions: `add_contact` and `update_contact_fields`. `get_contact` and `list_contacts` return `fields`; `list_contacts` filters by one field with `field` and `value` (`?field=sun_sign&value=scorpio`), or contacts without it with `field` alone.

### CSV import and export

The dashboard's import reads these columns as fields, alongside email, status and dates:

- `first_name` (also First Name, FNAME, Given Name), `sun_sign` (also Sun Sign, Zodiac Sign, Star Sign) and `life_path` (also Life Path Number);
- any other field as a column named `fields.<name>`, e.g. `fields.ref_code`;
- `source` for where the contact signed up (new contacts only).

Other columns are skipped, so a platform's dozens of columns don't become fields. A value that doesn't fit its field (a `sun_sign` of `dragon`) leaves that field out, not the contact. Fields in a file fill in existing contacts too; their status still only gets stricter.

`import_contacts` (`POST /api/v1/contacts/import`) takes `fields` and `source` on each row. Exports write every field in a column the import reads back.

## Merge tags

Anywhere in a campaign's or sequence step's subject, preview text or content:

| Tag | Prints |
|---|---|
| `{{first_name}}` | The contact's field, or nothing when it has none |
| `{{first_name\|there}}` | The field, or `there` |
| `{{email}}`, `{{source}}` | The contact's address, where it signed up |

- Values are escaped for HTML: a name like `<b>Mira</b>` shows as written and can't change the email. The fallback is printed as you wrote it.
- Tags are filled before links are tracked, so `https://example.com/?utm_term={{sun_sign|all}}` reaches each reader with their sign.
- Tags are written tight. `{{ name }}` with spaces is left as it is, like a template or code sample in an issue.
- MailCheap's placeholders (`{{unsubscribe_url}}`, `{{subject}}`, `{{preview_text}}`, `{{confirm_url}}`) work as before.
- Test emails go to you, without fields, so they show the fallbacks. So does the issue's page on the archive.

## Audiences

`create_campaign` and `update_campaign` take `audience`: the fields its contacts have to match. A list accepts any of its values, `null` in a list matches contacts without the field, and every field has to match.

```json
{ "subject": "Scorpio, this week", "format": "html", "content": "<html>…</html>", "audience": { "sun_sign": "scorpio" } }
```

```json
{ "audience": { "sun_sign": ["leo", "aries", "sagittarius"], "life_path": 7 } }
```

`get_campaign` shows `audience` and `audienceContacts`, the active contacts it lets in. Sending, scheduling, the plan check, the warm-up pace and `send_campaign_to_more` all keep to it. `"audience": null` on `update_campaign` removes it.

One campaign per sign, plus one for readers without a sign:

```js
for (const sign of SIGNS) await create({ subject: `${title(sign)}: this week`, content: html[sign], audience: { sun_sign: sign } });
await create({ subject: "This week", content: html.all, audience: { sun_sign: [null] } });
```

The dashboard's campaign editor doesn't show audiences yet: a campaign with one sent from the dashboard still keeps to it, but the dashboard's count shows every active contact. Check `get_campaign`'s `audienceContacts` before sending.
