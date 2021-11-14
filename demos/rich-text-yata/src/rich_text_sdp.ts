import * as crdts from "@collabs/collabs";
import { CListInsertEvent } from "@collabs/collabs";

function range(count: number) {
  return [...Array(count).keys()];
}

class RichTextCharacter extends crdts.CObject {
  // This is the structure of each object in the array.
  public character: string; // Character being represented
  public attributes: crdts.LwwCMap<string, any>; // Current attributes CRDT

  constructor(initToken: crdts.CrdtInitToken, character: string) {
    super(initToken);
    this.character = character;
    this.attributes = this.addChild("attributes", crdts.Pre(crdts.LwwCMap)());
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
  attributes: Record<string, any>;
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
    this.formatMessenger.on(
      "Message",
      this.frmtMssgHndl_formatCharacters(this)
    );

    this.rtCharArray = this.addChild(
      "rtCharArray",
      crdts.Pre(crdts.DeletingMutCList)(
        (valueInitToken: crdts.CrdtInitToken, character: string) => {
          const newChar = new RichTextCharacter(valueInitToken, character);
          newChar.attributes.on(
            "Set",
            this.attrSetHndl_emitFormatEvent(this)(newChar)
          );
          return newChar;
        },
        [["\n"]]
      )
    );
    this.rtCharArray.on("Insert", this.charInstHndl_inheritAttributes(this));
    this.rtCharArray.on("Insert", this.charInstHndl_emitInsertEvent(this));
    this.rtCharArray.on("Delete", this.charDelHndl_emitDeleteEvent(this));
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

  private frmtMssgHndl_formatCharacters =
    (model: RichText) => (e: crdts.CMessengerEvent<MFormat>) => {
      model.handleMFormat(model.store.processM1(e.message, e.meta.timestamp));
    };

  private handleMFormat = (m: MFormat | null) => {
    if (m) {
      this.runtime.runLocally(() => {
        m.targets.forEach((target) => {
          Object.entries(m.attributes).forEach((kv) => {
            target.attributes.set(kv[0], kv[1]);
          });
        });
      });
    }
  };

  private attrSetHndl_emitFormatEvent =
    (model: RichText) => (character: RichTextCharacter) => {
      return (e: crdts.CMapSetEvent<string, any>) => {
        model.emit("Format", {
          startIndex: model.rtCharArray.findIndex(
            (value) => value === character
          ),
          attributeName: e.key,
          attributeValue: character.attributes.get(e.key),
          meta: e.meta,
        });
      };
    };

  private charInstHndl_inheritAttributes =
    (model: RichText) => (e: crdts.CListInsertEvent) => {
      range(e.count).forEach((i) => {
        const idx = e.startIndex + i;
        const character = model.rtCharArray.get(idx);

        if (idx > 0) {
          const leftCharAttributes = model.rtCharArray.get(idx - 1).attributes;
          character.inheritLeftAttributesLocally(leftCharAttributes);
        }

        // processM2 is more like record M2
        model.store.processM2({ character }, e.meta.timestamp);
      });
    };

  private charInstHndl_emitInsertEvent =
    (model: RichText) => (e: CListInsertEvent) => {
      const text = range(e.count)
        .map((i) => {
          const idx = e.startIndex + i;
          return model.rtCharArray.get(idx).character;
        })
        .join("");
      model.emit("Insert", {
        startIndex: e.startIndex,
        text,
        attributes: Object.fromEntries(
          model.rtCharArray.get(e.startIndex).attributes.entries()
        ),
        meta: e.meta,
      });
    };

  private charDelHndl_emitDeleteEvent =
    (model: RichText) => (e: crdts.CListDeleteEvent<RichTextCharacter>) => {
      model.emit("Delete", {
        startIndex: e.startIndex,
        count: e.count,
        meta: e.meta,
      });
    };

  public formatText(
    startIndex: number,
    count: number,
    attributes: Record<string, any>
  ) {
    const targets = range(count).map((i) => {
      const idx = startIndex + i;
      return this.rtCharArray.get(idx);
    });
    this.formatMessenger.sendMessage({ targets, attributes });
  }

  public insertRichText(
    startIndex: number,
    text: string,
    attributes: Record<string, any>
  ) {
    let uniqueAttributes: Record<string, any> = {};
    if (startIndex > 0) {
      const leftAttributes = this.rtCharArray.get(startIndex - 1).attributes;
      Object.entries(attributes).forEach((kv) => {
        if (kv[1] !== leftAttributes.get(kv[0])) {
          uniqueAttributes[kv[0]] = kv[1];
        }
      });
      for (const kv of leftAttributes.entries()) {
        if (!attributes[kv[0]]) {
          uniqueAttributes[kv[0]] = null;
        }
      }
    } else {
      uniqueAttributes = attributes;
    }

    this.insertPlainText(startIndex, text);
    this.formatText(startIndex, text.length, uniqueAttributes);
  }

  private insertPlainText(startIndex: number, text: string) {
    text.split("").forEach((c, i) => {
      this.rtCharArray.insert(startIndex + i, c);
    });
  }

  public deleteText(startIndex: number, count: number) {
    this.rtCharArray.delete(startIndex, count);
  }
}
