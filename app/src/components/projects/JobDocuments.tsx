// The job's paperwork that is not a planset (Monday files, F6).
//
// Sits with Plans and Review on the job's own screen, because that is where
// somebody goes looking for "the signed order" while standing on a site. Every
// row today came across from the job's Monday item; the office used to be the
// only place any of it existed.
//
// CREW-FACING, so every word goes through t() in both languages. Read-only:
// nothing here deletes a document and nothing here adds one — the pull inside
// monday-sync is the only writer, and the table holds no client write grant.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { formatApiError } from "../../lib/errors";
import { useT } from "../../lib/i18n";
import {
  jobDocumentSignedUrl,
  listJobDocuments,
  type JobDocument,
} from "../../lib/jobDocuments";
import { fileSizeLabel } from "../../lib/mondaySync";

export function JobDocuments({ projectId }: { projectId: string }) {
  const t = useT();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const docs = useQuery({
    queryKey: ["jobDocuments", projectId],
    queryFn: () => listJobDocuments(projectId),
    enabled: !!projectId,
  });

  // The bucket is private and stays private — a signed order has a price on it
  // — so the link is minted at the moment of the tap and lasts ten minutes.
  const open = async (doc: JobDocument) => {
    setError(null);
    setOpening(doc.id);
    try {
      const url = await jobDocumentSignedUrl(doc);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setOpening(null);
    }
  };

  const rows = docs.data ?? [];

  return (
    <section style={{ marginTop: 12 }} data-testid="job-documents">
      <h2 style={{ margin: 0 }}>{t("jobDocuments.heading")}</h2>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
          {t("jobDocuments.empty")}
        </p>
      ) : (
        <ul className="unit-list" style={{ marginTop: 8 }}>
          {rows.map((d) => {
            const size = fileSizeLabel(d.size_bytes);
            return (
              <li key={d.id} className="find-row" style={{ flexWrap: "wrap", gap: 6 }}>
                <span
                  style={{
                    minWidth: 0,
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <FileText size={14} aria-hidden />
                  <span style={{ minWidth: 0 }}>
                    {d.name}
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {size ? ` · ${size}` : ""}
                      {d.source === "monday" ? ` · ${t("mondayFiles.fromMonday")}` : ""}
                      {/* Only somebody who can see costs is ever handed this
                          row at all — the wall is the table's policy, not this
                          line. It says why the crew on the site cannot open
                          it, so nobody has to guess the list is broken. */}
                      {d.money === true ? ` · ${t("jobDocuments.officeOnly")}` : ""}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  className="button-like"
                  disabled={opening === d.id}
                  onClick={() => void open(d)}
                >
                  {opening === d.id ? t("jobDocuments.opening") : t("jobDocuments.open")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
