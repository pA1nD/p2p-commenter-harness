// The agent's copy of the review: an append-only JSONL log, replayed into
// memory on start. One line per change, so it diffs and greps well:
//
//   {"op":"comment", ...row}        new comment (or a resolved/reopened event row)
//   {"op":"comment_delete","id"}
//   {"op":"comment_status","page_path","anchor_json","status","at"}
//   {"op":"edit", ...row}           suggested copy edit (or event row)
//   {"op":"edit_status","page_path","anchor_json","status"}
//
// Row shapes match what the overlay renders (the original commenter schema).

import fs from "node:fs";

export class Store {
  constructor(file) {
    this.file = file;
    this.comments = [];
    this.edits = [];
    this.maxId = { comment: 0, edit: 0 }; // ids are never reused, even after a delete
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          // e.g. a write cut short by a crash, or a merge conflict marker
          return process.stderr.write(`commenter: skipping unreadable line ${i + 1} of ${file}\n`);
        }
        this.apply(rec);
      });
    }
  }

  apply(rec) {
    const { op, ...r } = rec;
    if (op === "comment") {
      this.comments.push(r);
      this.maxId.comment = Math.max(this.maxId.comment, r.id);
    } else if (op === "comment_delete") {
      this.comments = this.comments.filter((c) => c.id !== r.id);
    } else if (op === "comment_status") {
      for (const c of this.thread(r.page_path, r.anchor_json)) {
        c.status = r.status;
        c.resolved_at = r.status === "resolved" ? r.at : null;
      }
    } else if (op === "edit") {
      for (const e of this.edits) {
        if (e.page_path === r.page_path && e.anchor_json === r.anchor_json && !e.superseded_at && !r.event) e.superseded_at = r.created_at;
      }
      this.edits.push(r);
      this.maxId.edit = Math.max(this.maxId.edit, r.id);
    } else if (op === "edit_status") {
      for (const e of this.edits) {
        if (e.page_path === r.page_path && e.anchor_json === r.anchor_json && !e.event) e.status = r.status;
      }
    }
  }

  write(rec) {
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    this.apply(rec);
  }

  // Comments (and event rows) sharing one anchor on one page form a thread.
  thread(page, anchorJson) {
    return this.comments.filter((c) => c.page_path === page && c.anchor_json === anchorJson && !c.event);
  }

  addComment({ page, anchorJson, body, author, event = null }) {
    const row = {
      id: this.maxId.comment + 1,
      page_path: page,
      anchor_json: anchorJson,
      body: event ? "" : String(body).slice(0, 5000),
      author_client_id: author.clientId,
      author_name: author.name || null,
      author_email: author.email || null,
      status: "open",
      created_at: Date.now(),
      resolved_at: null,
      ...(event ? { event } : {}),
    };
    this.write({ op: "comment", ...row });
    return row;
  }

  deleteComment(id) {
    this.write({ op: "comment_delete", id });
  }

  setThreadStatus(page, anchorJson, status) {
    this.write({ op: "comment_status", page_path: page, anchor_json: anchorJson, status, at: Date.now() });
  }

  addEdit({ page, anchorJson, originalText, newText, author, event = null }) {
    const row = {
      id: this.maxId.edit + 1,
      page_path: page,
      anchor_json: anchorJson,
      original_text: event ? "" : String(originalText).slice(0, 10000),
      new_text: event ? "" : String(newText).slice(0, 10000),
      author_client_id: author.clientId,
      author_name: author.name || null,
      author_email: author.email || null,
      created_at: Date.now(),
      superseded_at: null,
      status: "open",
      ...(event ? { event } : {}),
    };
    this.write({ op: "edit", ...row });
    return row;
  }

  setEditStatus(page, anchorJson, status) {
    this.write({ op: "edit_status", page_path: page, anchor_json: anchorJson, status });
  }
}
