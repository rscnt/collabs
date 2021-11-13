import * as crdts from "@collabs/collabs";
import { CListInsertEvent } from "@collabs/collabs";

function range(count: number) {
  return [...Array(count).keys()];
}

class RichTextCharacter extends crdts.CObject {
  // This is the structure of each object in the array.
  public character: string; // Character being represented
  public attributes: crdts.LwwCMap<string, any>; // Current attributes CRDT
  public deleted: crdts.LwwCRegister<boolean>;

  constructor(initToken: crdts.CrdtInitToken, character: string) {
    super(initToken);
    this.character = character;
    this.attributes = this.addChild("attributes", crdts.Pre(crdts.LwwCMap)());
    this.deleted = this.addChild(
      "deleted",
      crdts.Pre(crdts.LwwCRegister)(false as boolean)
    );
  }

  inheritLeftAttributesLocally(attributes: crdts.LwwCMap<string, any>) {
    this.runtime.runLocally(() => {
      for (const kv of attributes.entries()) {
        this.attributes.set(kv[0], kv[1]);
      }
    });
  }
}

interface RichTextEvents extends crdts.CrdtEventsRecord {
  Insert: RichTextInsertEvent;
  Delete: RichTextDeleteEvent;
  Format: RichTextFormatEvent;
}

export interface RichTextInsertEvent extends crdts.CrdtEvent {
  startIndex: number;
  text: string;
}

export interface RichTextDeleteEvent extends crdts.CrdtEvent {
  startIndex: number;
  count: number;
}

export interface RichTextFormatEvent extends crdts.CrdtEvent {
  startIndex: number;
  attributeName: string;
  attributeValue: any;
}

type RichTextArrayInsertArgs = [character: string];

interface MFormat {
  targets: RichTextCharacter[];
  attributes: Record<string, any>;
}

interface MPlainTextInsert {
  character: RichTextCharacter;
}

export class RichText extends crdts.CObject<RichTextEvents> {
  private store: crdts.SemidirectProductStore<MFormat, MPlainTextInsert>;
  private formatMessenger: crdts.CMessenger<MFormat>;
  private rtCharArray: crdts.DeletingMutCList<
    RichTextCharacter,
    RichTextArrayInsertArgs
  >;

  constructor(initToken: crdts.CrdtInitToken) {
    super(initToken);

    this.store = this.addChild(
      "store",
      crdts.Pre(crdts.SemidirectProductStore)(
        this.action_putFormatFirst,
        crdts.DefaultElementSerializer.getInstance(),
        true,
        true
      )
    );

    this.formatMessenger = this.addChild(
      "formatMessenger",
      crdts.Pre(crdts.CMessenger)()
    );
    this.formatMessenger.on("Message", this.formatMessageHandler);

    this.rtCharArray = this.addChild(
      "rtCharArray",
      crdts.Pre(crdts.DeletingMutCList)(
        (valueInitToken: crdts.CrdtInitToken, character: string) => {
          const newChar = new RichTextCharacter(valueInitToken, character);
          newChar.attributes.on(
            "Set",
            this.attrSetHndl_emitFormatEvent(newChar)
          );
          newChar.deleted.on("Set", this.delSetHndl_emitDeleteEvent(newChar));
          return newChar;
        },
        [["start"], ["end"]]
      )
    );
    this.rtCharArray.on("Insert", this.charInstHndl_inheritAttributes);
    this.rtCharArray.on("Insert", this.charInstHndl_emitInsertEvent);
  }

  private action_putFormatFirst(
    m2: MPlainTextInsert,
    m1: MFormat
  ): MFormat | null {
    const insertedChar = m2.character;
    const insertedCharIdx = this.rtCharArray.findIndex(
      (value) => value === insertedChar
    );

    const rightmostTargetedChar = m1.targets[m1.targets.length - 1];
    const rightmostTargetedCharIdx = this.rtCharArray.findIndex(
      (value) => value === rightmostTargetedChar
    );

    if (insertedCharIdx - rightmostTargetedCharIdx === 1) {
      return {
        targets: [...m1.targets, insertedChar],
        attributes: m1.attributes,
      };
    } else {
      return m1;
    }
  }

  private formatMessageHandler(e: crdts.CMessengerEvent<MFormat>) {
    this.handleMFormat(this.store.processM1(e.message, e.meta.timestamp));
  }

  private handleMFormat(m: MFormat | null) {
    if (m) {
      this.runtime.runLocally(() => {
        m.targets.forEach((target) => {
          Object.entries(m.attributes).forEach((kv) => {
            target.attributes.set(kv[0], kv[1]);
          });
        });
      });
    }
  }

  private delSetHndl_emitDeleteEvent(character: RichTextCharacter) {
    return (e: crdts.CRegisterEvent<boolean>) => {
      this.emit("Delete", {
        startIndex: this.rtCharArray.findIndex((value) => value === character),
        count: 1,
        meta: e.meta,
      });
    };
  }

  private attrSetHndl_emitFormatEvent(character: RichTextCharacter) {
    return (e: crdts.CMapSetEvent<string, any>) => {
      this.emit("Format", {
        startIndex: this.rtCharArray.findIndex((value) => value === character),
        attributeName: e.key,
        attributeValue: character.attributes.get(e.key),
        meta: e.meta,
      });
    };
  }

  private charInstHndl_inheritAttributes(e: crdts.CListInsertEvent) {
    range(e.count).forEach((i) => {
      const idx = e.startIndex + i;
      const leftCharAttributes = this.rtCharArray.get(idx - 1).attributes;
      const character = this.rtCharArray.get(idx);

      character.inheritLeftAttributesLocally(leftCharAttributes);

      // processM2 is more like record M2
      this.store.processM2({ character }, e.meta.timestamp);
    });
  }

  private charInstHndl_emitInsertEvent(e: CListInsertEvent) {
    const text = range(e.count)
      .map((i) => {
        const idx = e.startIndex + i;
        return this.rtCharArray.get(idx).character;
      })
      .join("");
    this.emit("Insert", {
      startIndex: e.startIndex,
      text,
      meta: e.meta,
    });
  }

  public formatText(
    startIndex: number,
    count: number,
    attributes: Record<string, any>
  ) {
    const targets = range(count).map((i) => {
      const idx = startIndex + i + 1;
      return this.rtCharArray.get(idx);
    });
    this.formatMessenger.sendMessage({ targets, attributes });
  }

  public insertRichText(
    startIndex: number,
    text: string,
    attributes: Record<string, any>
  ) {
    // TODO: Get unique attributes. (Should I handle this logic here or in the code that integrates it with quill?)
    const leftAttributes = this.rtCharArray.get(startIndex).attributes;
    const uniqueAttributes = Object.fromEntries(
      Object.entries(attributes).filter((kv) => {
        return kv[1] !== leftAttributes.get(kv[0]);
      })
    );

    this.insertPlainText(startIndex, text);
    this.formatText(startIndex, text.length, uniqueAttributes);
  }

  private insertPlainText(startIndex: number, text: string) {
    text.split("").forEach((c, i) => {
      this.rtCharArray.insert(startIndex + i + 1, c);
    });
  }

  public deleteText(startIndex: number, count: number) {
    range(count).forEach((i) => {
      const idx = startIndex + i + 1;
      this.rtCharArray.get(idx).deleted.set(true);
    });
  }
}
