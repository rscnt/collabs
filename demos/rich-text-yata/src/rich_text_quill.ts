import * as crdts from "@collabs/collabs";
import { ContainerRuntimeSource } from "@collabs/container";
import Quill, { DeltaOperation } from "quill";
import {RichText, RichTextDeleteEvent, RichTextFormatEvent, RichTextInsertEvent} from "./rich_text_sdp";

(async function () {
  // Rich Text CRDT setup
  const runtime = await ContainerRuntimeSource.newRuntime(
    window.parent,
    new crdts.RateLimitBatchingStrategy(200)
  );
  let richText = runtime.registerCrdt("richText", crdts.Pre(RichText)());

  // Quill setup
  require("quill/dist/quill.snow.css");
  let quill = new Quill("#editor", {
    theme: "snow",
  });
  
  // Quill event handling
  quill.on("text-change", (delta, oldDelta, source) => {
    if (source === "user") {
      let startIndex = 0;
      delta.forEach((op) => {
        if (!op.retain || op.attributes) {
          processSingleDeltaOperation(startIndex, op);
        }
        startIndex += op.retain ?? op.delete ?? (op.insert as string).length;
      });
    }
  });
  function processSingleDeltaOperation(
    startIndex: number,
    op: DeltaOperation
  ): void {
    switch (true) {
      case !!op.insert:
        richText.insertTextWithAttributes(
          startIndex,
          op.insert as string,
          op.attributes ?? {}
        );
        break;
      case !!op.delete:
        richText.deleteText(startIndex, op.delete!);
        break;
      case !!(op.attributes && op.retain):
        richText.formatText(startIndex, op.retain!, op.attributes!);
        break;
    }
  }

  // Rich Text CRDT event handling
  let Delta = Quill.import("delta");
  richText.on("Insert", ({ startIndex, text, meta }: RichTextInsertEvent) => {
    if (!meta.isLocal) {
      quill.updateContents(
        new Delta().retain(startIndex).insert(text)
      );
    }
  });
  richText.on("Delete", ({ startIndex, count, meta }: RichTextDeleteEvent) => {
    if (!meta.isLocal) {
      quill.updateContents(new Delta().retain(startIndex).delete(count));
    }
  });
  richText.on(
    "Format",
    ({ startIndex, attributeName, attributeValue, meta }: RichTextFormatEvent) => {
      quill.updateContents(new Delta().retain(startIndex).retain(1, { [attributeName]: attributeValue }));
    }
  );
})();
