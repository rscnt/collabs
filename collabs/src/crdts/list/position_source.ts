import {
  PositionSourceMetadataMessage,
  PositionSourceSave,
} from "../../../generated/proto_compiled";
import { FoundLocation } from "../../data_types";
import { int64AsNumber } from "../../util";

export type Position = [sender: string, counter: number, valueIndex: number];

/**
 * Every non-root waypoint must have at least one value.
 */
class Waypoint {
  constructor(
    /**
     * "" for the root.
     */
    readonly sender: string,
    /**
     * Nonnegative, increases monotonically (so you can
     * store value arrays in an array.).
     */
    readonly counter: number,
    /**
     * null only for the root.
     *
     * Mutable only for during loading (then is temporarily
     * null while we construct everything).
     */
    public parentWaypoint: Waypoint | null,
    /**
     * The valueIndex of our true parent (a value within
     * parentWaypoint).
     *
     * Unspecified for the root.
     */
    readonly parentValueIndex: number
  ) {}

  /**
   * The number of present values at this waypoint or its
   * descendants.
   */
  totalPresentValues = 0;
  /**
   * The children (both left + right) in LtR order.
   *
   * A child is one of:
   * - A child waypoint, i.e., a waypoint that is a true
   * child of one of this waypoint's values.
   * - A positive number, indicating a number of present values.
   * - A negative number, indicating a number of unpresent values
   * equal to its absolute value.
   *
   * Since every waypoint must have at least one value (including the root's
   * fake value), this is nonempty.
   */
  children: (Waypoint | number)[] = [];
}

export class PositionSource {
  /**
   * Map key is waypoint.sender, index in the array is waypoint.counter.
   */
  private readonly waypointsByID = new Map<string, Waypoint[]>();
  /**
   * Root waypoint.
   */
  private readonly rootWaypoint: Waypoint;

  /**
   * Used for assigning unique counters to our Waypoints.
   *
   * >= 0.
   */
  private nextCounter = 0;

  /**
   * [constructor description]
   * @param replicaID TODO: uniqueness, reusability;
   * must not be "".
   * @param initialValuesCount=0 The number of initial
   * values in the list, i.e., values that are present
   * at the list's creation before any operations are
   * performed. The initial values are assigned the positions
   * ["", 0, i] for i in [0, initialValuesCount),
   * i.e., you should store them keyed by those positions.
   */
  constructor(readonly replicaID: string, initialValuesCount = 0) {
    if (replicaID === "") {
      throw new Error('replicaID must not be ""');
    }
    this.rootWaypoint = new Waypoint("", 0, null, 0);
    // Fake leftmost value, marked as unpresent.
    this.rootWaypoint.children.push(-1);
    // Initial values.
    if (initialValuesCount > 0) {
      this.rootWaypoint.children.push(initialValuesCount);
      this.rootWaypoint.totalPresentValues = initialValuesCount;
    }
  }

  /**
   * Includes error checking.
   */
  private getWaypoint(sender: string, counter: number): Waypoint {
    const bySender = this.waypointsByID.get(sender);
    if (bySender === undefined) {
      throw new Error(
        "Unknown position, did you forget to receivePositions/receiveAndAddPositions? (reason: sender)"
      );
    }

    if (counter < 0) {
      throw new Error("Invalid position: counter < 0");
    }
    if (counter >= bySender.length) {
      throw new Error(
        "Unknown position, did you forget to receivePositions/receiveAndAddPositions? (reason: counter)"
      );
    }
    return bySender[counter];
  }

  // TODO: in interface version, take an extra arg "count" just in case
  createPositions(
    startIndex: number
  ): [counter: number, startValueIndex: number, metadata: Uint8Array | null] {
    if (startIndex < 0 || startIndex > this.length) {
      throw new Error(
        `startIndex out of bounds: ${startIndex} (length: ${this.length})`
      ); // `
    }

    // The position to the left of our insertion point
    // ("leftNeighbor").
    // Present unless it's the fake leftmost value.
    // Specifically, we represent this position as the value
    // at leftOffset within the number
    // leftWaypoint.children[leftChildIndex]
    let leftWaypoint = this.rootWaypoint;
    let leftChildIndex = 0;
    let leftOffset: number;

    if (startIndex === 0) {
      // Left neighbor is the fake leftmost value.
      leftOffset = 0;
    } else {
      [leftWaypoint, leftChildIndex, leftOffset] = this.getInternal(
        startIndex - 1
      );
    }
    const leftChild = <number>leftWaypoint.children[leftChildIndex];
    const leftValueIndex = this.getValueIndex(
      leftWaypoint,
      leftChildIndex,
      leftOffset
    );

    // The created position will be a new true right child
    // of left neighbor, unless left neighbor already has a
    // right child. In that case, we will instead be a new
    // true left child of rightNeighbor, which we define to
    // be the next (possibly unpresent) value to the right of
    // left neighbor.
    //
    // (Since we count unpresent values in the definition of rightNeighbor, it is impossible for left neighbor
    // to have a right child and rightNeighbor to have
    // a left child: they would end up being desendants
    // of each other. Thus our created position always has
    // no existing same-side true siblings.)

    // See if leftWaypoint has no values after leftNeighbor.
    let isLastValue = true;
    if (leftOffset !== Math.abs(leftChild) - 1) {
      isLastValue = false;
    } else {
      for (let i = leftWaypoint.children.length - 1; i > leftChildIndex; i--) {
        if (typeof leftWaypoint.children[i] === "number") {
          isLastValue = false;
          break;
        }
      }
    }
    if (isLastValue) {
      // leftWaypoint has no values after leftNeighbor.
      // However, it is possible that the next leftWaypoint
      // child is a true right child of leftNeighbor.
      if (leftChildIndex + 1 < leftWaypoint.children.length) {
        const nextChild = <Waypoint>leftWaypoint.children[leftChildIndex + 1];
        if (nextChild.parentValueIndex === leftValueIndex) {
          // Become the new leftmost descendant of nextChild.
          return this.createLeftmostDescendant(nextChild);
        }
      }
      // If we get here, then leftNeighbor has no true right
      // children; become its right child.
      if (leftWaypoint.sender === this.replicaID) {
        // Reuse leftWaypoint.
        return [leftWaypoint.counter, leftValueIndex + 1, null];
      } else {
        return this.createNewWaypoint(leftWaypoint, leftValueIndex, "right");
      }
    }

    // If we get here, then leftNeighbor already has a right
    // child; find rightNeighbor and become its new
    // leftmost descendant.
    if (leftOffset === Math.abs(leftChild) - 1) {
      // rightNeighbor comes from the next child.
      const nextChild = leftWaypoint.children[leftChildIndex + 1];
      if (typeof nextChild !== "number") {
        // Become the new leftmost descendant of nextChild.
        return this.createLeftmostDescendant(nextChild);
      }
    }
    // If we get here, then rightNeighbor is the next of
    // leftWaypoint's values.
    return this.createNewWaypoint(leftWaypoint, leftValueIndex + 1, "left");
  }

  private createLeftmostDescendant(
    waypoint: Waypoint
  ): [counter: number, startValueIndex: number, metadata: Uint8Array | null] {
    let curWaypoint = waypoint;
    for (;;) {
      const firstChild = curWaypoint.children[0];
      if (typeof firstChild === "number") {
        // The leftmost child of curWaypoint is a value.
        // That is necessarily the leftmost descendant of
        // waypoint.
        // Note because we are a left child, there is no
        // chance to reuse curWaypoint, even if we sent it.
        return this.createNewWaypoint(curWaypoint, 0, "left");
      } else {
        // firstChild is a waypoint; "recurse".
        curWaypoint = firstChild;
      }
    }
  }

  private createNewWaypoint(
    parentWaypoint: Waypoint,
    parentValueIndex: number,
    childSide: "left" | "right"
  ): [counter: number, startValueIndex: number, metadata: Uint8Array | null] {
    const message = PositionSourceMetadataMessage.create({
      parentWaypointSender:
        parentWaypoint.sender === this.replicaID
          ? undefined
          : parentWaypoint.sender,
      parentWaypointCounterAndSide:
        childSide === "right"
          ? parentWaypoint.counter
          : ~parentWaypoint.counter,
      parentValueIndex,
    });
    const metadata = PositionSourceMetadataMessage.encode(message).finish();
    return [this.nextCounter, 0, metadata];
  }

  receivePositions(
    startPos: Position,
    count: number,
    metadata: Uint8Array | null
  ): void {
    this.receivePositionsInternal(startPos, count, metadata, -1);
  }

  // TODO: return insertion index?

  receiveAndAddPositions(
    startPos: Position,
    count: number,
    metadata: Uint8Array | null
  ): void {
    this.receivePositionsInternal(startPos, count, metadata, 1);
    // TODO: also add
  }

  private receivePositionsInternal(
    startPos: Position,
    count: number,
    metadata: Uint8Array | null,
    sign: 1 | -1
  ): void {
    if (startPos[0] === "") {
      throw new Error('Invalid startPos: sender is ""');
    }
    if (startPos[2] < 0) {
      throw new Error(`Invalid startPos: valueIndex is < 0 (${startPos[1]})`);
    }

    if (metadata === null) {
      // The new positions are just new values appended to
      // startPos's waypoint.
      const waypoint = this.getWaypoint(startPos[0], startPos[1]);
      const lastChild = waypoint.children[waypoint.children.length - 1];
      if (typeof lastChild === "number" && sign * lastChild > 0) {
        // lastChild reps the same kind of values as
        // the received positions; "add" to it.
        waypoint.children[waypoint.children.length - 1] =
          lastChild + sign * count;
      } else {
        // Make a new child with the new values.
        waypoint.children.push(sign * count);
      }
    } else {
      const decoded = PositionSourceMetadataMessage.decode(metadata);

      // Get parentWaypoint.
      const parentWaypointSender = Object.prototype.hasOwnProperty.call(
        decoded,
        "parentWaypointSender"
      )
        ? decoded.parentWaypointSender
        : startPos[0];
      const parentWaypointCounterAndSide = int64AsNumber(
        decoded.parentWaypointCounterAndSide
      );
      let parentWaypointCounter: number;
      let side: "left" | "right";
      if (parentWaypointCounterAndSide >= 0) {
        parentWaypointCounter = parentWaypointCounterAndSide;
        side = "right";
      } else {
        parentWaypointCounter = ~parentWaypointCounterAndSide;
        side = "left";
      }
      const parentWaypoint = this.getWaypoint(
        parentWaypointSender,
        parentWaypointCounter
      );

      // Create a new waypoint based on startPos.
      if (startPos[1] < 0) {
        throw new Error(`Invalid startPos: counter is < 0 (${startPos[1]})`);
      }
      const newWaypoint = new Waypoint(
        startPos[0],
        startPos[1],
        parentWaypoint,
        decoded.parentValueIndex
      );
      newWaypoint.children.push(sign * count);

      // Store newWaypoint in this.waypoints.
      if (newWaypoint.sender === "") {
        throw new Error(
          'Invalid call to receivePositions: startPos\'s sender is "", which is a reserved replicaID'
        );
      }
      if (newWaypoint.counter === 0) {
        // New sender.
        if (this.waypointsByID.has(newWaypoint.sender)) {
          throw new Error(
            `Invalid call to receivePositions: counter is not the next counter from sender (counter = ${
              newWaypoint.counter
            }, should be ${this.waypointsByID.get(newWaypoint.sender)!.length})`
          );
        }
        this.waypointsByID.set(newWaypoint.sender, [newWaypoint]);
      } else {
        const bySender = this.waypointsByID.get(newWaypoint.sender);
        if (bySender === undefined || newWaypoint.counter !== bySender.length) {
          throw new Error(
            `Invalid call to receivePositions: counter is not the next counter from sender (counter = ${
              newWaypoint.counter
            }, should be ${bySender === undefined ? 0 : bySender.length})`
          );
        }
        bySender.push(newWaypoint);
      }

      // Store newWaypoint in parentWaypoint.children.
      if (side === "right") {
        if (newWaypoint.sender === parentWaypoint.sender) {
          throw new Error(
            "Invalid call to receivePositions: startPos does not correspond to metadata (right side same senders)"
          );
        }
        // Regardless of newWaypoint.parentValueIndex, it
        // goes to the right of all values: any values that
        // are not causally to its left are sibling insertions
        // by parentWaypoint.sender, which we arbitrarily
        // sort on the left.
        // Remains to sort newWaypoint
        // among any waypoint children at the end, in order:
        // reverse parentValueIndex, then sender.
        for (
          let childIndex = parentWaypoint.children.length - 1;
          childIndex >= 0;
          childIndex--
        ) {
          const child = parentWaypoint.children[childIndex];
          if (
            typeof child === "number" ||
            child.parentValueIndex > newWaypoint.parentValueIndex ||
            (child.parentValueIndex === newWaypoint.parentValueIndex &&
              child.sender < newWaypoint.sender)
          ) {
            // child is lesser; insert after.
            parentWaypoint.children.splice(childIndex + 1, 0, newWaypoint);
            return;
          }
        }
        // If we get here, newWaypoint is less than every child.
        parentWaypoint.children.unshift(newWaypoint);
      } else {
        // side === "left"
        if (newWaypoint.parentValueIndex === 0) {
          // newWaypoint goes before all values.
          // Remains to sort newWaypoint among any
          // waypoint siblings, in order by sender.
          this.insertLeftChild(parentWaypoint, newWaypoint, 0);
        } else {
          // First find valueIndex - 1 (which is to our left)
          // within children.
          let remaining = newWaypoint.parentValueIndex - 1;
          let childIndex: number;
          let childCount!: number;
          for (
            childIndex = 0;
            childIndex < newWaypoint.children.length;
            childIndex++
          ) {
            const child = newWaypoint.children[childIndex];
            if (typeof child === "number") {
              childCount = Math.abs(child);
              if (remaining <= childCount) break;
              else remaining -= childCount;
            }
          }
          if (childIndex === newWaypoint.children.length) {
            throw new Error(
              "Invalid call to receivePositions: the parent valueIndex is not known"
            );
          }
          const child = <number>newWaypoint.children[childIndex];
          if (remaining < childCount) {
            // Need to split child.
            const sign = Math.sign(child);
            newWaypoint.children.splice(
              childIndex,
              1,
              sign * (remaining + 1),
              newWaypoint,
              sign * (childCount - remaining - 1)
            );
          } else {
            // newWaypoint goes after child.
            // Remains to sort newWaypoint among any
            // waypoint siblings, in order by sender.
            this.insertLeftChild(parentWaypoint, newWaypoint, childIndex + 1);
          }
        }
      }
    }
  }

  /**
   * Inserts newWaypoint into parentWaypoint as a left
   * child of some value, sorting it among its siblings.
   * searchStart is the first place to search (LtR), i.e.,
   * the childIndex after (true parent value - 1).
   * This method sorts newWaypoint among any siblings
   * that appear from searchStart until the next value
   * (or the end), in order by sender.
   */
  private insertLeftChild(
    parentWaypoint: Waypoint,
    newWaypoint: Waypoint,
    searchStart: number
  ) {
    for (
      let nextChildIndex = searchStart;
      nextChildIndex < newWaypoint.children.length;
      nextChildIndex++
    ) {
      const nextChild = parentWaypoint.children[nextChildIndex];
      // Note nextChild could be a true right child
      // of newWaypoint.parentValueIndex - 1; we
      // are greater than those.
      if (
        typeof nextChild === "number" ||
        (nextChild.parentValueIndex === newWaypoint.parentValueIndex &&
          nextChild.sender > newWaypoint.sender)
      ) {
        // nextChild is greater; insert before.
        parentWaypoint.children.splice(nextChildIndex, 0, newWaypoint);
        return;
      }
    }
    // If we get here, newWaypoint is greater than every child.
    parentWaypoint.children.push(newWaypoint);
  }

  // TODO: if finding the index has a cost, should
  // we skip it / make optional?
  // In the case where it's actually
  // added, you'll pretty much always want the index,
  // but if it's already added, you prob don't care.

  /**
   * [add description]
   * @param  pos [description]
   * @return     Whether pos was actually added, i.e., it
   * was previously not present.
   */
  add(pos: Position): boolean {
    return this.addOrDelete(pos, 1);
  }

  // TODO: how to do optimized delete range?
  // (Finding first and last indices, then looping over
  // them and deleting some but not all.)

  // TODO: if finding the index has a cost, should
  // we skip it / make optional?
  // Although I guess in the case where it's actually
  // deleted, you'll pretty much always want the index.

  /**
   * [delete description]
   * @param  pos [description]
   * @return     Whether pos was actually added, i.e., it
   * was previously present.
   */
  delete(pos: Position): boolean {
    return this.addOrDelete(pos, -1);
  }

  private addOrDelete(pos: Position, sign: 1 | -1): boolean {
    // Find waypoint.
    const bySender = this.waypointsByID.get(pos[0]);
    if (bySender === undefined) {
      throw new Error(
        "Unknown position, did you forget to receivePositions/receiveAndAddPositions? (reason: sender)"
      );
    }

    if (pos[1] < 0) {
      throw new Error("Invalid position: counter < 0");
    }
    if (pos[1] >= bySender.length) {
      throw new Error(
        "Unknown position, did you forget to receivePositions/receiveAndAddPositions? (reason: counter)"
      );
    }
    const waypoint = bySender[pos[1]];

    // Find valueIndex in waypoint.children.
    if (pos[2] < 0) {
      throw new Error("Invalid position: valueIndex < 0");
    }
    let remaining = pos[2];
    let childIndex: number;
    for (childIndex = 0; childIndex < waypoint.children.length; childIndex++) {
      const child = waypoint.children[childIndex];
      if (typeof child === "number") {
        const count = Math.abs(child);
        if (remaining < count) break;
        remaining -= count;
      }
    }
    if (childIndex === waypoint.children.length) {
      throw new Error(
        "Unknown position, did you forget to receivePositions/receiveAndAddPositions? (reason: valueIndex)"
      );
    }
    const child = <number>waypoint.children[childIndex];

    // Add it if needed.
    if (sign * child > 0) return false;

    const mergePrev =
      remaining === 0 &&
      childIndex > 0 &&
      typeof waypoint.children[childIndex - 1] === "number" &&
      sign * <number>waypoint.children[childIndex - 1] > 0;
    const mergeNext =
      remaining === -child - 1 &&
      childIndex < waypoint.children.length - 1 &&
      typeof waypoint.children[childIndex + 1] === "number" &&
      sign * <number>waypoint.children[childIndex + 1] > 0;

    // TODO: test every case
    if (child === -sign && remaining === 0) {
      if (mergePrev && mergeNext) {
        waypoint.children.splice(
          childIndex - 1,
          3,
          <number>waypoint.children[childIndex - 1] +
            sign * +(<number>waypoint.children[childIndex + 1])
        );
      } else if (mergePrev) {
        waypoint.children.splice(
          childIndex - 1,
          2,
          <number>waypoint.children[childIndex - 1] + sign
        );
      } else if (mergeNext) {
        waypoint.children.splice(
          childIndex,
          2,
          sign + <number>waypoint.children[childIndex + 1]
        );
      } else {
        waypoint.children[childIndex] = sign;
      }
    } else if (remaining === 0) {
      if (mergePrev) {
        (<number>waypoint.children[childIndex - 1]) += sign;
        (<number>waypoint.children[childIndex]) += sign;
      } else {
        waypoint.children.splice(childIndex, 1, sign, child + sign);
      }
    } else if (remaining === -sign * child - 1) {
      if (mergeNext) {
        (<number>waypoint.children[childIndex]) += sign;
        (<number>waypoint.children[childIndex + 1]) += sign;
      } else {
        waypoint.children.splice(childIndex, 1, child + sign, sign);
      }
    } else {
      // Split child.
      waypoint.children.splice(
        childIndex,
        1,
        -sign * remaining,
        sign,
        child + sign * (remaining + 1) // -sign * (abs(child) - (remaining + 1))
      );
    }
    return true;
  }

  get(index: number): Position {
    if (index < 0 || index >= this.length) {
      throw new Error(`index out of bounds: ${index} (length: ${this.length})`);
    }

    const [waypoint, childIndex, offset] = this.getInternal(index);
    const valueIndex = this.getValueIndex(waypoint, childIndex, offset);
    return [waypoint.sender, waypoint.counter, valueIndex];
  }

  // TODO: optimize forward/backwards loop access

  /**
   * index must be valid; else may infinite loop.
   *
   * The indicated child will always be a positive number, since
   * we only consider present values.
   */
  private getInternal(
    index: number
  ): [waypoint: Waypoint, childIndex: number, offset: number] {
    // Tree walk.
    let curWaypoint = this.rootWaypoint;
    for (;;) {
      // Walk the children of curWaypoint.
      for (
        let childIndex = 0;
        childIndex < curWaypoint.children.length;
        childIndex++
      ) {
        const child = curWaypoint.children[childIndex];
        if (typeof child === "number") {
          if (child > 0) {
            // Present values.
            if (index < child) {
              // Found the value; return.
              return [curWaypoint, childIndex, index];
            }
            index -= child;
          }
          // else unpresent values; skip over.
        } else {
          if (index < child.totalPresentValues) {
            // child contains the value, "recurse" by
            // going to the next outer loop iteration.
            curWaypoint = child;
            break;
          }
          index -= child.totalPresentValues;
        }
      }
    }
  }

  private getValueIndex(
    waypoint: Waypoint,
    childIndex: number,
    offset: number
  ) {
    let subtotal = 0;
    for (let i = 0; i < childIndex; i++) {
      const child = waypoint.children[i];
      if (typeof child === "number") subtotal += Math.abs(child);
    }
    return subtotal + offset;
  }

  get length(): number {
    return this.rootWaypoint.totalPresentValues;
  }

  // TODO: change to FoundPosition once that's changed in Collabs.
  find(pos: Position): FoundLocation {
    const waypoint = this.getWaypoint(pos[0], pos[1]);

    // geIndex within waypoint's subtree.
    let [geIndex, isPresent] = this.findWithinSubtree(waypoint, pos[2]);

    // Now account for present values to the left of
    // waypoint's subtree.
    let curWaypoint = waypoint;
    let curParent = curWaypoint.parentWaypoint;
    while (curParent !== null) {
      // Loop through curParent's children until we find
      // curWaypoint, adding up their indices.
      for (const child of curParent.children) {
        if (typeof child === "number") {
          if (child > 0) geIndex += child;
        } else if (child === curWaypoint) {
          // Done looping over children.
          break;
        } else {
          geIndex += child.totalPresentValues;
        }
      }

      // Now find where curParent is within its own parent.
      curWaypoint = curParent;
      curParent = curWaypoint.parentWaypoint;
    }

    return new FoundLocation(geIndex, isPresent);
  }

  /**
   * @return [the geIndex of the given valueIndex within
   * waypoint's subtree, whether it is present]
   */
  private findWithinSubtree(
    waypoint: Waypoint,
    valueIndex: number
  ): [geIndex: number, isPresent: boolean] {
    if (valueIndex < 0) {
      throw new Error("Invalid position: valueIndex < 0");
    }

    let geIndex = 0;
    let remaining = valueIndex;
    for (const child of waypoint.children) {
      if (typeof child === "number") {
        const count = Math.abs(child);
        if (remaining < count) {
          // Found valueIndex.
          if (child > 0) {
            // Present.
            return [geIndex + remaining, true];
          } else {
            // Unpresent.
            return [geIndex, false];
          }
        } else {
          remaining -= count;
          if (child > 0) geIndex += count;
        }
      } else {
        geIndex += child.totalPresentValues;
      }
    }

    // If we get to here, we didn't find valueIndex.
    throw new Error(
      "Unknown position, did you forget to receivePositions/receiveAndAddPositions? (reason: valueIndex)"
    );
  }

  *positions(): IterableIterator<Position> {
    // Walk the tree.
    const stack: [waypoint: Waypoint, childIndex: number, offset: number][] =
      [];
    let waypoint = this.rootWaypoint;
    let childIndex = 0;
    let offset = 0;
    for (;;) {
      if (childIndex === waypoint.children.length) {
        // Done with this waypoint; pop the stack.
        if (stack.length === 0) {
          // Completely done.
          return;
        }
        [waypoint, childIndex, offset] = stack.pop()!;
        childIndex++;
        continue;
      }

      const child = waypoint.children[childIndex];
      if (typeof child === "number") {
        if (child > 0) {
          // Yield child values.
          for (let i = 0; i < child; i++) {
            yield [waypoint.sender, waypoint.counter, offset];
            offset++;
          }
        } else {
          // Deleted values; skip.
          offset += -child;
        }
      } else {
        // Waypoint child. Recurse if nonempty, else skip.
        if (child.totalPresentValues > 0) {
          stack.push([waypoint, childIndex, offset]);
          waypoint = child;
          childIndex = 0;
          offset = 0;
          continue;
        }
      }

      // Move to the next child.
      childIndex++;
    }
  }

  // TODO
  // *positionsOpt(
  //   startIndex = 0
  // ): IterableIterator<
  //   [
  //     sender: string | null,
  //     counter: string | null,
  //     startIndex: number,
  //     count: number
  //   ]
  // > {
  // }

  save(): Uint8Array {
    const replicaIDs: string[] = [];
    const replicaCounts: number[] = [];
    // Maps replicaIDs to the first index corresponding
    // to that replicaID in parentWaypoints.
    const startIndices = new Map<string, number>();
    let index = 0;
    for (const [replicaID, waypoints] of this.waypointsByID) {
      if (replicaID === "") continue;
      replicaIDs.push(replicaID);
      replicaCounts.push(waypoints.length);
      startIndices.set(replicaID, index);
      index += waypoints.length;
    }

    const parentWaypoints: number[] = [];
    const parentValueIndices: number[] = [];
    const totalPresentValuess: number[] = [];
    const children: number[] = [];
    const childTypes: number[] = [];
    for (const waypoints of this.waypointsByID.values()) {
      for (const waypoint of waypoints) {
        if (waypoint !== this.rootWaypoint) {
          const parentWaypoint = waypoint.parentWaypoint!;
          if (parentWaypoint === this.rootWaypoint) {
            parentWaypoints.push(0);
          } else {
            parentWaypoints.push(
              1 +
                startIndices.get(parentWaypoint.sender)! +
                parentWaypoint.counter
            );
            parentValueIndices.push(waypoint.parentValueIndex);
          }
        }
        // We are guaranteed rootWaypoint is first since
        // it is in the first entry in waypointsByID.
        totalPresentValuess.push(waypoint.totalPresentValues);
        for (
          let childIndex = 0;
          childIndex < waypoint.children.length;
          childIndex++
        ) {
          const startTag = childIndex === waypoint.children.length - 1 ? 4 : 0;
          const child = waypoint.children[childIndex];
          if (typeof child === "number") {
            if (child > 0) {
              children.push(child);
              childTypes.push(0 + startTag);
            } else {
              children.push(-child);
              childTypes.push(1 + startTag);
            }
          } else {
            children.push(startIndices.get(child.sender)! + child.counter);
            childTypes.push(2 + startTag);
          }
        }
      }
    }

    const message = PositionSourceSave.create({
      oldReplicaID: this.replicaID,
      oldNextCounter: this.nextCounter,
      replicaIDs,
      replicaCounts,
      parentWaypoints,
      parentValueIndices,
      totalPresentValuess,
      children,
      childTypes,
    });
    return PositionSourceSave.encode(message).finish();
  }

  load(saveData: Uint8Array): void {
    const decoded = PositionSourceSave.decode(saveData);

    if (decoded.oldReplicaID === this.replicaID) {
      this.nextCounter = decoded.oldNextCounter;
    }

    // All waypoints, in order [root, then same order
    // as parentWaypoints].
    // I.e., indices = values in parentWaypoints.
    const allWaypoints: Waypoint[] = [this.rootWaypoint];

    // Fill in this.waypointsByID and allWaypoints.
    let i = 0; // Index into parentWaypoints.
    for (
      let replicaIDIndex = 0;
      replicaIDIndex < decoded.replicaIDs.length;
      replicaIDIndex++
    ) {
      const replicaID = decoded.replicaIDs[replicaIDIndex];
      const bySender: Waypoint[] = [];
      this.waypointsByID.set(replicaID, bySender);

      for (
        let counter = 0;
        counter < decoded.replicaCounts[replicaIDIndex];
        counter++
      ) {
        const waypoint = new Waypoint(
          replicaID,
          counter,
          null, // parentWaypoint is set later.
          decoded.parentValueIndices[i]
        );
        bySender.push(waypoint);
        allWaypoints.push(waypoint);
        i++;
      }
    }

    // Set waypoint parentWaypoints. Note we skip rootWaypoint.
    for (let j = 1; j < allWaypoints.length; j++) {
      allWaypoints[j].parentWaypoint =
        allWaypoints[decoded.parentWaypoints[j - 1]];
    }

    // Set waypoint children.
    let childrenIndex = 0;
    for (let j = 0; j < allWaypoints.length; j++) {
      const waypoint = allWaypoints[j];
      waypoint.totalPresentValues = int64AsNumber(
        decoded.totalPresentValuess[j]
      );
      for (;;) {
        const child = decoded.children[childrenIndex];
        const childType = decoded.childTypes[childrenIndex];
        childrenIndex++;
        switch (childType & 3) {
          case 0: // Positive number.
            waypoint.children.push(child);
            break;
          case 1: // Negative number.
            waypoint.children.push(-child);
            break;
          case 2: // Waypoint.
            waypoint.children.push(allWaypoints[child - 1]);
            break;
        }
        if ((childType & 4) === 4) break;
      }
    }
  }
}
