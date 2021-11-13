import * as crdts from "@collabs/collabs";

interface RichTextCharacterEvents extends crdts.CrdtEventsRecord {}

class RichTextCharacter extends crdts.CObject<RichTextCharacterEvents> {
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

interface RichTextEvents extends crdts.CrdtEventsRecord {}

type RichTextArrayInsertArgs = [character: string];

interface MFormat {
  targets: RichTextCharacter[];
  attributes: Record<string, any>;
}

interface MAttributelessInsert {
  character: RichTextCharacter;
}

class RichText extends crdts.CObject<RichTextEvents> {
  private store: crdts.SemidirectProductStore<MFormat, MAttributelessInsert>;
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
        this.action,
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
          return new RichTextCharacter(valueInitToken, character);
        },
        [["start"], ["end"]]
      )
    );
    this.rtCharArray.on("Insert", this.rtCharArrayInsertHandler);
  }

  private action(m2: MAttributelessInsert, m1: MFormat): MFormat | null {
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

  private rtCharArrayInsertHandler(e: crdts.CListInsertEvent) {
    for (let i = e.startIndex; i < e.startIndex + e.count; i++) {
      const leftCharAttributes: crdts.LwwCMap<string, any> =
        this.rtCharArray.get(i - 1).attributes;
      const newChar = this.rtCharArray.get(i);

      newChar.inheritLeftAttributesLocally(leftCharAttributes);

      // processM2 is more like record M2
      this.store.processM2({ character: newChar }, e.meta.timestamp);
    }
  }

  public formatText(
    startIndex: number,
    count: number,
    attributes: Record<string, any>
  ) {
    const targets = [...Array(count).keys()].map((i) => {
      const idx = startIndex + i + 1;
      return this.rtCharArray.get(idx);
    });
    this.formatMessenger.sendMessage({ targets, attributes });
  }

  public insertTextWithAttributes(
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

    this.insertTextAndInheritAttributes(startIndex, text);
    this.formatText(startIndex, text.length, uniqueAttributes);
  }

  private insertTextAndInheritAttributes(startIndex: number, text: string) {
    text.split("").forEach((c, i) => {
      this.rtCharArray.insert(startIndex + i + 1, c);
    });
  }
}
