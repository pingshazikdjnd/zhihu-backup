import "dotenv/config";
import type {
  IngestCollectionSnapshotInput,
  IngestCommentsInput,
  IngestContentInput
} from "shared";

const API_BASE = process.env.API_BASE || "http://localhost:3001";

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }

  return res.json();
}

export function sendContent(body: IngestContentInput) {
  return post("/ingest/content", body);
}

export function sendComments(body: IngestCommentsInput) {
  return post("/ingest/comments", body);
}

export function sendCollectionSnapshot(body: IngestCollectionSnapshotInput) {
  return post("/ingest/collection-snapshot", body);
}
