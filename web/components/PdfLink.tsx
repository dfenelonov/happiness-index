"use client";

import { track } from "./analytics";

export function PdfLink({ orderId }: { orderId: string }) {
  return (
    <a href={`/api/report/${orderId}/pdf`} className="btn-primary" onClick={() => track("pdf_download", { order_id: orderId })} data-testid="pdf">
      Скачать PDF
    </a>
  );
}
