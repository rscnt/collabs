import * as crdts from "@collabs/collabs";

interface RichTextCharacterEvents extends crdts.CrdtEventsRecord {}

// Let's first try to define m1, m2, and |>
// Vaguely, m1 is a formatting action, and m2 is an inserting action.
// BOB     "a" -> "A"  -> "AB"
// ALICE   "a" -> "ab" -> "AB"
// So let's define m2 to be: insert string, and copy all formatting attributes from left unless the attribute is known to be different at input time.
// Define m1 to be: change the formatting attributes of a character accordingly.

class RichTextCharacter extends crdts.CObject<RichTextCharacterEvents> {
  // This is the structure of each object in the array.
  public character: string; // Character being represented
  public attributes: crdts.LwwCMap<string, any>; // Current attributes CRDT
  public attributesDifferentFromLeftChar: string[]; // List of attribute names that are different from origin at create time
  public attributesAtCreation: Record<string, any>; 
  public attributesInitialized: boolean;

  // TODO: What if I take in a reference to the CRDT of the origin?
  // TODO: What if I just carry over formatting from the left unless different?

  constructor(
    initToken: crdts.CrdtInitToken,
    character: string,
    attributesDifferentFromLeftChar: string[],
    attributesAtCreation: Record<string, any>
  ) {
    super(initToken);
    this.character = character;
    this.attributesDifferentFromLeftChar = attributesDifferentFromLeftChar;
    this.attributesAtCreation = attributesAtCreation;
    this.attributes = this.addChild("attributes", crdts.Pre(crdts.LwwCMap)());
    this.attributesInitialized = false;
  }

  initializeAttributesLocally(attributes: Record<string, any>) {
    this.runtime.runLocally(() => {
      attributes.entries.forEach((key: string, value: any) => {
        this.attributes.set(key, value);
      });
      this.attributesInitialized = true;
    });
  }
}

interface RichTextEvents extends crdts.CrdtEventsRecord {}

type RichTextArrayInsertArgs = [
  character: string,
  attributesDifferentFromLeftChar: string[],
  attributesAtCreation: Record<string, any>
];

class RichText extends crdts.CObject<RichTextEvents> {
  private rtCharArray: crdts.DeletingMutCList<
    RichTextCharacter,
    RichTextArrayInsertArgs
  >;

  constructor(initToken: crdts.CrdtInitToken) {
    super(initToken);
    this.rtCharArray = this.addChild(
      "rtCharArray",
      crdts.Pre(crdts.DeletingMutCList)(
        (
          valueInitToken: crdts.CrdtInitToken,
          character: string,
          attributesDifferentFromLeftChar: string[],
          attributesAtCreation: Record<string, any>
        ) => {
          return new RichTextCharacter(
            valueInitToken,
            character,
            attributesDifferentFromLeftChar,
            attributesAtCreation
          );
        },
        [
          ["start", [], {}],
          ["end", [], {}],
        ]
      )
    );
    this.rtCharArray.on("Insert", ({}) => {});
  }
  

  rtCharArrayInsertHandler(e: crdts.CListInsertEvent) {
    this.rtCharArray.
    e.
  };
}
