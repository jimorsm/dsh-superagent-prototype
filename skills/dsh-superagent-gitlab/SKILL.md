---
name: dsh-superagent-gitlab
description: Read and act on GitLab issues, merge requests and notes using glab.
---

Workers use orchestrator_read for trigger context when needed: trigger/<id> for the original todo, issue, merge request or note, and thread/<key> for the conversation the host already holds.
A thread key is gitlab:issue-<iid> or gitlab:mr-<iid>.
Reading does not create tickets or send replies.
Anything beyond what the host holds is read with glab, which acts as the deployment's GitLab account on the instance $DSH_SUPERAGENT_GITLAB_HOST.

Use glab for every GitLab call, always with an explicit API path; glab api paths this installation allows start with projects/<url-encoded $DSH_SUPERAGENT_GITLAB_PROJECT>/.
Plain examples: glab api projects/:id/issues/<iid> for one issue, glab api projects/:id/merge_requests/<iid> for one merge request, glab api 'projects/:id/issues/<iid>/notes?sort=asc&order_by=updated_at&per_page=100' for the conversation, and glab api projects/:id/repository/files/<url-encoded-path>/raw?ref=<branch> for one file.
The project id is not the path: use the numeric id or the URL-encoded path from $DSH_SUPERAGENT_GITLAB_PROJECT.

Before substantial work on a new human request, call orchestrator_ack with its original trigger ID and a brief request-specific text; the host replies once in that issue or merge request.
Do not acknowledge bots.

Deliver work as merge requests.
Create a branch named after the ticket (its last path segment is $DSH_SUPERAGENT_NAME), push it with git (credentials are preconfigured), then open the merge request with glab api projects/:id/merge_requests --method POST -f source_branch=<branch> -f target_branch=<default branch> -f title=<title> -f description=<description> -f remove_source_branch=true.
Never push to the default branch, never merge directly, and never enable auto-merge other than as the Delivery requirements section says.
Close issues only when the Delivery requirements section says so.

Answer review discussions in the merge request's discussion thread they belong to: list them with glab api projects/:id/merge_requests/<iid>/discussions, and reply with glab api projects/:id/merge_requests/<iid>/discussions/<discussion-id>/notes --method POST -f body=<text>.
Resolve a discussion only as the Communication section says, with glab api projects/:id/merge_requests/<iid>/discussions/<discussion-id> --method PUT -f resolved=true.

Immediately after creating or adopting a ticket merge request, call orchestrator_report with state: progress and pr_number (the merge request iid); do not wait for pipelines.
Commit as the author the Delivery requirements section names, otherwise as $DSH_SUPERAGENT_GITLAB_ACCOUNT with $DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL; both override local defaults.
Read the original trigger before acting, and report with orchestrator_report when the work is complete or blocked with a concrete reason.
