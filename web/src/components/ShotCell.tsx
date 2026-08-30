import { useEffect, useRef, useState } from "react";
import { KIND_LABELS, type ImageKind, type ImageRecord } from "../lib/types.ts";

type Props = {
  kind: ImageKind;
  image?: ImageRecord;
  height: number;
  caption?: string;
  busy?: boolean;
  onUpload: (file: File) => void;
  onRemove?: () => void;
  /** Adds a document-level paste handler so ⌘V drops straight into this cell. */
  pasteTarget?: boolean;
};

function firstImageFile(list: FileList | DataTransferItemList | null): File | null {
  if (!list) return null;
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    if (item instanceof File) {
      if (item.type.startsWith("image/")) return item;
      continue;
    }
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file && file.type.startsWith("image/")) return file;
    }
  }
  return null;
}

export default function ShotCell({
  kind,
  image,
  height,
  caption,
  busy,
  onUpload,
  onRemove,
  pasteTarget,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (!pasteTarget || image) return;
    const handler = (event: ClipboardEvent) => {
      const file = firstImageFile(event.clipboardData?.items ?? null);
      if (file) {
        event.preventDefault();
        onUpload(file);
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [image, onUpload, pasteTarget]);

  return (
    <div className="shot-cell" style={{ ["--shot-h" as string]: `${height}px` }}>
      <div className="shot-cell-head">
        <span>{KIND_LABELS[kind]}</span>
        {busy ? (
          <span className="mono" style={{ fontSize: 9.5, color: "var(--gold)" }}>
            UPLOADING…
          </span>
        ) : image ? (
          <span className="shot-cell-actions">
            <span className="mono" style={{ fontSize: 9.5, color: "var(--green)" }}>
              UPLOADED
            </span>
            <button className="linkish" onClick={() => input.current?.click()}>
              เปลี่ยน
            </button>
            {onRemove ? (
              <button className="linkish danger" onClick={onRemove}>
                ลบ
              </button>
            ) : null}
          </span>
        ) : (
          <span className="mono" style={{ fontSize: 9.5, color: "var(--gold)" }}>
            รอภาพ
          </span>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
          event.target.value = "";
        }}
      />

      {image ? (
        <button
          className="shot"
          style={{ height: "var(--shot-h)" }}
          onClick={() => input.current?.click()}
          title="คลิกเพื่อเปลี่ยนภาพ"
        >
          <img src={image.url} alt={`${KIND_LABELS[kind]} ${image.date}`} loading="lazy" decoding="async" />
          {caption ? <span className="tag">{caption}</span> : null}
        </button>
      ) : (
        <button
          className={`dropzone${over ? " over" : ""}`}
          style={{ height: "var(--shot-h)" }}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            const file = firstImageFile(event.dataTransfer.files);
            if (file) onUpload(file);
          }}
        >
          <span className="plus">{busy ? <span className="spin" /> : "+"}</span>
          <span>
            ลากภาพมาวาง
            <br />
            <small>{pasteTarget ? "หรือ ⌘V วางจากคลิปบอร์ด" : "หรือคลิกเพื่อเลือกไฟล์"}</small>
          </span>
        </button>
      )}
    </div>
  );
}
