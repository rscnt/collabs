import * as crdts from "@collabs/collabs";

interface RichTextCharacterEvents extends crdts.CrdtEventsRecord {}

class RichTextCharacter extends crdts.CObject<RichTextCharacterEvents> {
  // This is the structure of each object in the array.
  public character: string; // Character being represented
  public attributes: crdts.LwwCMap<string, any>; // Current attributes CRDT
  
  constructor(
    initToken: crdts.CrdtInitToken,
    character: string,
  ) {
    super(initToken);
    this.character = character;
    this.attributes = this.addChild("attributes", crdts.Pre(crdts.LwwCMap)());
  }

  inheriteLeftAttributesLocally(attributes: crdts.LwwCMap<string, any>) {
    this.runtime.runLocally(() => {
      for (const kv of attributes.entries()) {
        this.attributes.set(kv[0], kv[1]);
      }
    });
  }
}

interface RichTextEvents extends crdts.CrdtEventsRecord {}

type RichTextArrayInsertArgs = [
  character: string,
];

class RichText extends crdts.CObject<RichTextEvents> {
  private rtCharArray: crdts.DeletingMutCList<
    RichTextCharacter,
    RichTextArrayInsertArgs
  >;
  
  private rtCharArrayInsertHandler(e: crdts.CListInsertEvent) {
    for (let i = e.startIndex; i < e.startIndex + e.count; i++) {
      const leftCharAttributes: crdts.LwwCMap<string, any> = this.rtCharArray.get(i - 1).attributes;
      this.rtCharArray.get(i).inheriteLeftAttributesLocally(leftCharAttributes);
    }
  };

  private insertTextAndInheritAttributes(startIndex: number, text: string) {
    text.split("").forEach((c, i) => {
      this.rtCharArray.insert(startIndex + i + 1, c);
    });
  }

  constructor(initToken: crdts.CrdtInitToken) {
    super(initToken);
    this.rtCharArray = this.addChild(
      "rtCharArray",
      crdts.Pre(crdts.DeletingMutCList)(
        (
          valueInitToken: crdts.CrdtInitToken,
          character: string,
        ) => {
          return new RichTextCharacter(
            valueInitToken,
            character
          );
        },
        [
          ["start"],
          ["end"],
        ]
      )
    );
    this.rtCharArray.on("Insert", this.rtCharArrayInsertHandler); // Ini apa ya?
  }

  public formatText(startIndex: number, count: number, attributes: Record<string, any>) {
    for (let i = startIndex + 1; i < startIndex + 1 + count; i++) {
      const rtCharCrdtAttributes = this.rtCharArray.get(i).attributes;
      Object.entries(attributes).forEach((kv) => {
        rtCharCrdtAttributes.set(kv[0], kv[1]);
      });
    }
  }

  public insertTextWithAttributes(startIndex: number, text: string, attributes: Record<string, any>) {
    // TODO: Get unique attributes. (Should I handle this logic here or in the cod ethat integrates it with quill?)
    const leftAttributes = this.rtCharArray.get(startIndex).attributes;
    const uniqueAttributes = Object.fromEntries(Object.entries(attributes).filter((kv) => {
      kv[1] !== leftAttributes.get(kv[0]);
    }));

    this.insertTextAndInheritAttributes(startIndex, text);
    this.formatText(startIndex, text.length, uniqueAttributes);
  }
}
