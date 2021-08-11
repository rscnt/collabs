import {
  IMultiSemidirectProductSenderHistory,
  MultiSemidirectProductSave,
} from "../../../generated/proto_compiled";
import { CausalTimestamp } from "../../net";
import {
  Crdt,
  CrdtEventsRecord,
  CrdtParent,
  Runtime,
  StatefulCrdt,
} from "../core";
import { LocallyResettableState } from "./resettable";

class StoredMessage {
  message: Uint8Array;
  constructor(
    readonly sender: string,
    readonly senderCounter: number,
    readonly receiptCounter: number,
    readonly targetPath: string[],
    readonly timestamp: CausalTimestamp | null,
    readonly arbIndex: number, // arbitration number
    message: Uint8Array
  ) {
    this.message = message;
  }

  setMessage(newMessage: Uint8Array) {
    this.message = newMessage;
  }
}

class MultipleSemidirectStateBase<S extends Object> {
  protected receiptCounter = 0;
  // H maps i (arb index) -> history of messages from that CRDT
  protected history: Map<number, Array<StoredMessage>> = new Map();
  public internalState!: S;
  constructor(private readonly historyTimestamps: boolean) {}

  /**
   * Add message to the history with the given timestamp.
   * replicaId is our replica id.
   */
  add(
    replicaId: string,
    targetPath: string[],
    timestamp: CausalTimestamp,
    message: Uint8Array,
    arbId: number
  ) {
    let senderHistory = this.history.get(arbId);
    if (senderHistory === undefined) {
      senderHistory = [];
      this.history.set(arbId, senderHistory);
    }
    senderHistory.push(
      new StoredMessage(
        timestamp.getSender(),
        timestamp.getSenderCounter(),
        this.receiptCounter,
        targetPath,
        this.historyTimestamps ? timestamp : null,
        arbId,
        message
      )
    );
    this.receiptCounter++;
  }

  /**
   * Replace message value of a given message
   */
  replace(arbId: number, newMessage: Uint8Array, timestamp: CausalTimestamp) {
    let crdtHistory = this.history.get(arbId);
    if (crdtHistory === undefined) {
      return;
    }

    crdtHistory.forEach((msg: StoredMessage) => {
      if (msg.timestamp == timestamp) {
        msg.message = newMessage;
      }
    });
  }

  /**
   * Return all messages in the history concurrent to the given
   * timestamp, in some causal order (specifically, this replica's
   * receipt order).  If we are the sender (i.e., replicaId ===
   * timestamp.getSender()), it is assumed that the timestamp is
   * causally greater than all prior messages, as described in
   * CrdtInternal.effect, hence [] is returned.
   */
  getConcurrent(replicaId: string, timestamp: CausalTimestamp, arbId: number) {
    return this.processTimestamp(replicaId, timestamp, true, arbId);
  }

  /**
   * Performs specified actions on all messages in the history:
   * - if returnConcurrent is true, returns the list of
   * all messages in the history concurrent to timestamp, in
   * receipt order.
   * - if discardDominated is true, deletes all messages from
   * the history whose timestamps are causally dominated by
   * or equal to the given timestamp.  (Note that this means that
   * if we want to keep a message with the given timestamp in
   * the history, it must be added to the history after calling
   * this method.)
   */
  private processTimestamp(
    replicaId: string,
    timestamp: CausalTimestamp,
    returnConcurrent: boolean,
    arbId: number
  ) {
    if (replicaId === timestamp.getSender()) {
      return [];
    }
    // Gather up the concurrent messages.  These are all
    // messages by each replicaId with sender counter
    // greater than timestamp.asVectorClock().get(replicaId).
    let concurrent: Array<StoredMessage> = [];
    let vc = timestamp.asVectorClock();
    for (let historyEntry of this.history.entries()) {
      let senderHistory = historyEntry[1];
      let vcEntry = vc.get(senderHistory[0].sender);
      if (vcEntry === undefined) vcEntry = -1;
      if (senderHistory !== undefined) {
        let concurrentIndexStart = MultipleSemidirectStateBase.indexAfter(
          senderHistory,
          vcEntry
        );
        if (returnConcurrent) {
          for (let i = concurrentIndexStart; i < senderHistory.length; i++) {
            // With multiple semidirect products, we only consider messages
            // from CRDTs with a higher arbitration index
            if (senderHistory[i].arbIndex > arbId) {
              concurrent.push(senderHistory[i]);
            }
          }
        }
      }
    }
    if (returnConcurrent) {
      // Sort concurrent messages by arbitration order then by receipt order.
      concurrent.sort((a, b) => {
        if (a.arbIndex == b.arbIndex)
          return a.receiptCounter - b.receiptCounter;
        else return a.arbIndex - b.arbIndex;
      });
      // Strip away everything except the messages.
      return concurrent;
    } else return [];
  }

  /**
   * Returns true if there are no messages stored in the history,
   * i.e., either there have been no crd1 messages, or
   * our SemidirectInternal's historyKeepOnlyConcurrent flag is true
   * and all crdt1 messages have been causally less than a crdt2
   * message.
   */
  isHistoryEmpty(): boolean {
    for (let value of this.history.values()) {
      if (value.length !== 0) return false;
    }
    return true;
  }

  /**
   * Get all messages from CRDTs with lower arbitration index
   */
  getLowerHistory(idx: number): StoredMessage[] {
    let hist: StoredMessage[] = [];

    for (let i = 0; i < idx; i++) {
      let messages = this.history.get(i);
      if (messages) {
        messages.forEach((msg) => {
          if (msg.arbIndex < idx) {
            hist.push(msg);
          }
        });
      }
    }

    return hist;
  }

  // Binary search to find first index in array with senderCounter
  // greater than given value
  private static binSearch(
    arr: Array<StoredMessage>,
    value: number,
    start: number,
    end: number
  ): number {
    if (start >= end) return start;

    let mid = Math.floor((start + end) / 2);

    if (arr[mid].senderCounter > value) {
      return this.binSearch(arr, value, start, mid - 1);
    } else {
      return this.binSearch(arr, value, mid + 1, end);
    }
  }

  private static indexAfter(
    sparseArray: Array<StoredMessage>,
    value: number
  ): number {
    // binary search when sparseArray is large
    // TODO: binsearch is not tested
    // if (sparseArray.length > 100) {
    //   return this.binSearch(sparseArray, value, 0, sparseArray.length);
    // }

    // Note that there may be duplicate timestamps.
    // So it would be inappropriate to find an entry whose
    // per-sender counter equals value and infer that
    // the desired index is 1 greater.
    for (let i = 0; i < sparseArray.length; i++) {
      if (sparseArray[i].senderCounter > value) return i;
    }
    return sparseArray.length;
  }

  save(runtime: Runtime): Uint8Array {
    const historySave: {
      [sender: string]: IMultiSemidirectProductSenderHistory;
    } = {};
    for (const [arbId, messages] of this.history) {
      historySave[arbId] = {
        messages: messages.map((message) => {
          return {
            sender: message.sender,
            senderCounter: message.senderCounter,
            receiptCounter: message.receiptCounter,
            targetPath: message.targetPath,
            timestamp: this.historyTimestamps
              ? runtime.timestampSerializer.serialize(message.timestamp!)
              : null,
            arbIndex: message.arbIndex,
            message: message.message,
          };
        }),
      };
    }
    const saveMessage = MultiSemidirectProductSave.create({
      receiptCounter: this.receiptCounter,
      history: historySave,
    });
    return MultiSemidirectProductSave.encode(saveMessage).finish();
  }

  load(saveData: Uint8Array, runtime: Runtime) {
    const saveMessage = MultiSemidirectProductSave.decode(saveData);
    this.receiptCounter = saveMessage.receiptCounter;
    for (const [arbId, messages] of Object.entries(saveMessage.history)) {
      this.history.set(
        parseInt(arbId),
        messages.messages!.map(
          (message) =>
            new StoredMessage(
              message.sender,
              message.senderCounter,
              message.receiptCounter,
              message.targetPath!,
              this.historyTimestamps
                ? runtime.timestampSerializer.deserialize(
                    message.timestamp!,
                    runtime
                  )
                : null,
              message.arbIndex,
              message.message
            )
        )
      );
    }
  }
}

class MultipleSemidirectStateLocallyResettable<S extends LocallyResettableState>
  extends MultipleSemidirectStateBase<S>
  implements LocallyResettableState
{
  resetLocalState(timestamp: CausalTimestamp) {
    this.receiptCounter = 0;
    this.history.clear();
    this.internalState.resetLocalState(timestamp);
  }
}

// TODO: instead of subclass, have interface for all-but-reset part of
// SemidirectState, then have just one class including reset?
export type MultipleSemidirectState<S> = S extends LocallyResettableState
  ? MultipleSemidirectStateBase<S> & LocallyResettableState
  : MultipleSemidirectStateBase<S>;

export abstract class MultipleSemidirectProduct<
    S extends Object,
    Events extends CrdtEventsRecord = CrdtEventsRecord
  >
  extends Crdt<Events>
  implements StatefulCrdt<MultipleSemidirectState<S>>, CrdtParent
{
  readonly state: MultipleSemidirectState<S>;

  /**
   * TODO
   * @param historyTimestamps=false        [description]
   */
  constructor(historyTimestamps = false) {
    super();
    // Types are hacked a bit here to make implementation simpler
    this.state = new MultipleSemidirectStateLocallyResettable<
      S & LocallyResettableState
    >(historyTimestamps) as MultipleSemidirectState<S>;
  }

  protected crdts!: Array<StatefulCrdt<S>>;

  /**
   * TODO
   * @param  m2TargetPath [description]
   * @param  m2Timestamp  [description]
   * @param  m2Message    [description]
   * @param  m2Index      [description]
   * @param  m1TargetPath [description]
   * @param  m1Timestamp  [description]
   * @param  m1Message    [description]
   * @return              [description]
   */
  protected abstract action(
    m2TargetPath: string[],
    m2Timestamp: CausalTimestamp | null,
    m2Message: Uint8Array,
    m2Index: number,
    m1TargetPath: string[],
    m1Timestamp: CausalTimestamp,
    m1Message: Uint8Array
  ): { m1TargetPath: string[]; m1Message: Uint8Array } | null;

  protected setup(crdts: Array<StatefulCrdt<S>>, initialState: S) {
    this.state.internalState = initialState;
    this.crdts = crdts;
    crdts.forEach((crdt) => {
      // @ts-ignore Ignore readonly
      crdt.state = initialState;
    });

    if (this.afterInit) this.initChildren();
  }

  init(name: string, parent: CrdtParent) {
    super.init(name, parent);
    if (this.crdts[0] !== undefined) {
      this.initChildren();
    }
  }

  private initChildren() {
    for (let i = 0; i < this.crdts.length; i++) {
      let crdt = this.crdts[i];
      this.childBeingAdded = crdt;
      crdt.init("crdt" + i.toString(), this);
    }
  }

  private childBeingAdded?: Crdt;
  onChildInit(child: Crdt) {
    if (child != this.childBeingAdded) {
      throw new Error(
        "this was passed to Crdt.init as parent externally" +
          " (use this.setup instead)"
      );
    }
  }

  // The resulting message mact is then applied to σ and added to the history.
  // It also acts on all messages in the history with lower arbitration order,
  // regardless ofwhether they are concurrent or not.
  protected receiveInternal(
    targetPath: string[],
    timestamp: CausalTimestamp,
    message: Uint8Array
  ) {
    if (targetPath.length === 0) {
      throw new Error("TODO");
    }

    let idx: number;
    if (
      targetPath[targetPath.length - 1].substr(0, 4) == "crdt" &&
      (idx = parseInt(targetPath[targetPath.length - 1].substr(4))) !== NaN
    ) {
      targetPath.length--;
      let crdt = this.crdts[idx];

      // Act on all concurrent messages
      let concurrent = this.state.getConcurrent(
        this.runtime.replicaId,
        timestamp,
        idx
      );

      let mAct = {
        m1TargetPath: targetPath,
        m1Message: message,
      };
      for (let i = 0; i < concurrent.length; i++) {
        let mActOrNull = this.action(
          concurrent[i].targetPath,
          concurrent[i].timestamp,
          concurrent[i].message,
          concurrent[i].arbIndex,
          mAct.m1TargetPath,
          timestamp,
          mAct.m1Message
        );

        if (mActOrNull == null) return;
        else mAct = mActOrNull;
      }

      // mAct should act on all messages in history w/ lower order
      let hist = this.state.getLowerHistory(idx);
      hist.forEach((msg) => {
        if (msg.timestamp) {
          let acted = this.action(
            mAct.m1TargetPath,
            timestamp,
            mAct.m1Message,
            idx,
            msg.targetPath,
            msg.timestamp,
            msg.message
          );

          if (acted) msg.setMessage(acted.m1Message);
        }
      });

      // add mAct to state and history
      this.state.add(
        this.runtime.replicaId,
        targetPath.slice(),
        timestamp,
        mAct.m1Message,
        idx
      );

      crdt.receive(mAct.m1TargetPath, timestamp, mAct.m1Message);
    } else {
      throw new Error(
        "Unknown SemidirectProduct child: " +
          targetPath[targetPath.length - 1] +
          " in: " +
          JSON.stringify(targetPath)
      );
    }
  }

  getChild(name: string): Crdt {
    let idx: number;
    if (
      name.substr(0, 4) == "crdt" &&
      (idx = parseInt(name.substr(4))) !== NaN
    ) {
      let idx = parseInt(name.substr(4));
      return this.crdts[idx];
    } else {
      throw new Error(
        "Unknown child: " + name + " in MultipleSemidirectProduct: "
      );
    }
  }

  canGc(): boolean {
    // TODO: this may spuriously return false if one of the Crdt's is not
    // in its initial state only because we overwrote that state with
    // the semidirect initial state.  Although, for our Crdt's so far
    // (e.g NumberCrdt), it ends up working because they check canGC()
    // by asking the state if it is in its initial state.
    let crdtsCanGc = true;
    this.crdts.forEach((crdt) => {
      crdtsCanGc = crdtsCanGc && crdt.canGc();
    });

    return this.state.isHistoryEmpty() && crdtsCanGc;
  }

  save(): [saveData: Uint8Array, children: Map<string, Crdt>] {
    let crdts: [string, Crdt<CrdtEventsRecord>][] = [];
    for (let i = 0; i < this.crdts.length; i++) {
      crdts.push(["crdt" + i.toString(), this.crdts[i]]);
    }

    return [this.state.save(this.runtime), new Map(crdts)];
  }

  // TODO: the children loading their own states (both
  // of them, in arbitrary order) must correctly set
  // this.internalState, whatever it is.
  // Need option to do custom loading if that's not the
  // case.
  load(saveData: Uint8Array) {
    this.state.load(saveData, this.runtime);
  }
}