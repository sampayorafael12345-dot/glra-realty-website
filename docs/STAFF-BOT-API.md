# Staff desk API for the cloud supervisor

Updated 5 Oct 2026. Every field that existed before this date is still there with the same name and meaning; new fields are marked **(new)**.

**Sign-in:** send the header `x-glra-bot-key: <key>`. The key is made once in Admin → Staff → Cloud supervisor, and only its SHA-256 is stored.

**Rate limit:** 300 requests every 15 minutes.

**Work hours:** Monday to Friday, 9:00 to 18:00 Asia/Manila, lunch 12:00 to 13:00. Manila is UTC+8 all year.

---

## GET /api/staff-bot/snapshot

Query: `?day=YYYY-MM-DD`, `?day=today` or `?day=prev`. `prev` is the default: the working day before today.

### Top level

| Field | Meaning |
|---|---|
| `now`, `today`, `checkedDay` | Server time, today's Manila date, and the day being checked. |
| `workHours` | Now `"Mon-Fri 9:00-18:00 Asia/Manila, lunch 12:00-13:00"`. It was `9:00-17:00`. |
| `workHoursDetail` **(new)** | `{ days, start, end, lunchStart, lunchEnd, timezone, noDueBetween: "12:01-12:59" }` |
| `channels` | Posting channels: `{ key, col, label, every }`. SM = Facebook page, SM2 = groups, LC = portal, ATS = Authority to Sell. |
| `staff[]` | One entry per real staff account. Accounts marked "not staff" in the Staff tab are left out. |
| `waitingWork[]` | Suggested work: leads waiting, follow-ups, unanswered enquiries, owner submissions, listings not posted. Also, **(new)** possible duplicate listings (`issueKey dup:<a>:<b>`) and weak listings (`weak:<id>`): under 8 photos, a description under 200 characters, no map, or no area or price. |
| `listings[]` | Available listings with photo count, description length, map status and `lastPosted` per channel. |
| `previousReports[]` | The last 6 reports, including the new `alert` reports. |

### Each `staff[]` entry

| Field | Meaning |
|---|---|
| `id`, `name`, `email`, `lastSeen` | |
| `targets`, `todaySoFar`, `last7days` | Daily targets and counts (posts, contacts, tasks, actions, activeMin). |
| `day` | The full work log for `checkedDay`. **(new)** `day.timeRecord` is the same object as `timeRecord` below. |
| `todayStatus` | `{ checkIn, checkOut, state, activeMin }` for today. |
| `tasksFinishedOnDay[]` | `id, title, kind, completedAt, dueDate, proofUrl, proofNote, steps[], review, propertyId, botCheck`. **(new)** `proofCheck { ok, kind, reason, at }`, where kind is `fb_post`, `instagram`, `tiktok`, `portal`, `page` or `none`. Also `proofChannel`, `screenshots[]` (image URLs, extra proof only), and `closeFlags[]`: `bulk` means closed within 5 minutes of 2 or more others; `self_made` means the staff member made the task for themselves. |
| `postsOnDay[]` | `id, listing, propertyId, channel, url, postedAt, note, reusedLink`. |
| `openTasks[]` | `id, title, kind, status, dueDate, late, review, reviewNote, recurrence, propertyId, issueKey`. **(new)** `dueDay` (Manila date), `workdaysUntilDue`, and `dueProblem` (empty, or the reason the due time breaks the rules). |
| `lateTaskCount`, `messages[]`, `recentDays[]` | |
| `flags[]` | Plain-English problems. Several kinds were added **(new)**; see the list after this table. |
| `timeRecord` **(new)** | `{ day, timedIn, checkIn, checkOut, autoOut, noReport, late, lateMin, leftEarlyMin, workedMin, activeMin, untimedMin, lunch, idle[{from,to,min}], idleMin }`. `workedMin` leaves out lunch. Idle means 15 or more minutes with no dashboard activity during working time, not counting lunch or a break, field or meeting status. |
| `contactsOnDay[]` **(new)** | `{ leadId, lead, email, phone, how, at, outcome, note, hasOutcome }`. `how` is call, whatsapp, viber, messenger, sms, email, meeting, viewing or listings_sent. |
| `deletedTasks[]` **(new)** | `{ id, title, kind, status, dueDate, deletedAt, by, reason }` |
| `audit[]` **(new)** | `{ action, by, target, targetId, title, at, changes }`. Actions include TASK_DELETED, TASK_REOPENED, TASK_DUE_CHANGED, TASK_BULK_CLOSE, TASK_SUBMIT, TASK_APPROVE, TASK_RETURN, TIME_IN, TIME_OUT and POSTED. |
| `score5days` **(new)** | `{ rag, signals[{level,text}], targets, actual, percent, daysWorked, hoursWorked, idleMin, grades[] }`. These are the same numbers as the Staff tab dashboard and the weekly score. `actual` counts only proof-checked work: posts with a real post link, contacts with an outcome, and tasks with every step ticked plus a proof note or link. |

The new kinds of `flags[]` entry are:
- a post link that is not a single post
- a task closed in bulk
- a self-made task
- a task deleted
- no time-in on a working day
- no time-out, or timed out with no report
- 60 or more idle minutes
- minutes used while not timed in
- a contact logged with no outcome

## POST /api/staff-bot/tasks

Body: `{ tasks: [{ title, description, kind, priority, assignedTo, dueDate, checklist[], propertyId, issueKey, link, reference, points }] }`

Returns `{ created: [{id,title}], skipped: [{title, why}] }`, the same shape as before. A task now lands in `skipped` with a reason when:
- it is due on a weekend, before 9:00, after 18:00, or between 12:01 and 12:59
- it is due more than 10 working days away
- the same title is already on that person's list for the same day
- its `issueKey` is still open

## POST /api/staff-bot/messages

Body: `{ messages: [{ to, kind: note|fix|warning|praise, text, propertyId }] }`. Unchanged.

## POST /api/staff-bot/tasks/:id/check

Body: `{ verdict: ok|problem, note }`. Unchanged. A `problem` verdict now also sends one alert email.

## POST /api/staff-bot/report

Body: `{ kind: morning|plan|evening|other, day, subject, text, alsoEmailStaffId }`. Unchanged. For the weekly grade trend to work, put `grade X` in the subject of morning reports.

---

## What the server now does by itself

- **Lunch:** at 12:00 on working days, anyone with the status "working" is switched to "lunch". At 13:00 they are switched back, but only if the server made the switch.
- **18:30 close:** a day nobody timed out of is closed. The time-out is set to the last active minute (or 18:00), `autoOut` is set, and `noReport` is set if there is no end-of-day report.
- **Alert emails:** these go to the report list, each event only once. They can be switched off in the Cloud supervisor view. An alert is sent for:
  - no time-in by 9:30
  - 2 hours with no activity while timed in
  - a task deleted
  - a failed proof check
  - leads unanswered for more than one working day (a daily digest from 10:00)
  - no time-out or report

  Every alert email is also saved as a report of kind `alert`.
- **Friday weekly score:** sent after 18:30. It is built on the same numbers as the dashboard, and counts only real staff.

## Rules enforced on the staff desk

- A task can only be closed with every step ticked and a proof note of at least 10 characters. Admins are exempt.
- A posting task needs a real post link that has not been used before; the rules are in `server/staff-rules.js`. If the task has a listing, the post is also saved to the posting board with its date, channel and link.
- Staff cannot approve, send back or re-date their own tasks.
- Only admins can delete a task. A whole copy is kept in DeletedTask, along with who deleted it, when and why.
- A lead contact must have an outcome, or a note of 5 or more characters.
