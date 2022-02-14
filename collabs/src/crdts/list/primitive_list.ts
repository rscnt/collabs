import { PrimitiveCListMessage } from "../../../generated/proto_compiled";
import { InitToken, Message, MessageMeta } from "../../core";
import { AbstractCListCPrimitive } from "../../data_types";
import {
  DefaultSerializer,
  int64AsNumber,
  Optional,
  Serializer,
} from "../../util";
import { Resettable } from "../abilities";

// TODO: balanced tree (heap, RBTree, Seph Gentle tree?)
// instead of using the Waypoint tree, for indexing.

// TODO: for prepended values (negative indices), use
// backwards arrays? Since push is probably faster than
// unshift.
// Also, nicer way of deleting values? Splitting and shortening
// arrays may be inefficient.
// Both could be solved with linked list (like Yjs) or
// using built-in Array sparseness.

// TODO: description of the "true" tree vs waypoint rep.
// Root is a single always-deleted value.

/**
 * Every non-root waypoint must have at least one (possibly deleted) value.
 */
class Waypoint<T> {
  constructor(
    /**
     * "" for the root.
     */
    readonly sender: string,
    /**
     * Positive, except 0 for the root.
     */
    readonly counter: number,
    /**
     * null only for the root. But, we treat the
     * root's ID as null (not its non-existent parent).
     */
    readonly parentWaypoint: Waypoint<T> | null,
    /**
     * The index of our true parent (a value)
     * within parentWaypoint.
     *
     * Unspecified for the root.
     */
    readonly parentIndex: number
  ) {}

  /**
   * The number of present values at this waypoint or its
   * descendants.
   */
  numValues = 0;
  /**
   * The index of the first (possibly deleted) value
   * attached to this waypoint.
   *
   * <= 0 (negative numbers
   * indicate prepended values, i.e., true right children
   * of the 0th value).
   */
  startIndex = 0;
  /**
   * The children (both left + right) in LtR order.
   *
   * A child is one of:
   * - A child waypoint, i.e., a waypoint that is a true
   * child of one of this waypoint's values.
   * - A nonempty contiguous block of present values.
   * - A positive number, indicating a number of deleted values.
   *
   * Since every waypoint must have at least one value (including the root's
   * fake value), this is nonempty.
   */
  children: (Waypoint<T> | T[] | number)[] = [];
}

export class PrimitiveCList<T>
  extends AbstractCListCPrimitive<T, [T]>
  implements Resettable
{
  /**
   * Map key is waypoint.sender, index in the array is waypoint.counter - 1.
   */
  private readonly waypointsByID = new Map<string, Waypoint<T>[]>();
  /**
   * Root waypoint. Has no values, only right Waypoint
   * children. ID is null. Not included in waypointsByID.
   */
  private readonly rootWaypoint: Waypoint<T>;

  /**
   * Used for assigning unique counters to our Waypoints.
   *
   * >= 1 so we can add signs without confusing 0.
   */
  private sendCounter = 1;

  constructor(
    initToken: InitToken,
    protected readonly valueSerializer: Serializer<T> = DefaultSerializer.getInstance(
      initToken.runtime
    ),
    protected readonly valueArraySerializer:
      | Serializer<T[]>
      | undefined = undefined
  ) {
    super(initToken);

    this.rootWaypoint = new Waypoint<T>("", 0, null, 0);
    // Give the root a fake deleted value, to serve as
    // the root of of the "true" value tree.
    this.rootWaypoint.children.push(1);
  }

  // TODO: optimize bulk methods.

  insert(index: number, value: T): T;
  insert(index: number, ...values: T[]): T | undefined;
  insert(index: number, ...values: T[]): T | undefined {
    if (values.length === 0) return undefined;

    let ret!: T;
    for (let i = 0; i < values.length; i++) {
      const oneRet = this.insertOne(index + i, values[i]);
      if (i === 0) ret = oneRet;
    }
    return ret;
  }

  private insertOne(index: number, value: T): T {
    if (index < 0 || index > this.length) {
      throw new Error(`Index out of bounds: ${index} (length: ${this.length})`);
    }

    // Find left neighbor (value at index-1)'s tree location.
    // Waypoint:
    let leftWaypoint = this.rootWaypoint;
    // Child's index within leftWaypoint.children (a T[] child):
    let leftChildIndex = 0;
    // Value's index within child:
    let leftValueIndex = index - 1;

    if (index === 0) {
      // Special case: left neighbor is the root's sole
      // deleted value, at true index 0.
      leftValueIndex = 0;
    } else {
      // Thanks to the index check, we are guaranteed that we
      // will find the value (leftIndex is in [0, length)),
      // so an infinite loop is safe.
      leftNeighborSearch: {
        for (;;) {
          for (
            leftChildIndex = 0;
            leftChildIndex < leftWaypoint.children.length;
            leftChildIndex++
          ) {
            const child = leftWaypoint.children[leftChildIndex];
            if (typeof child === "number") {
              // Deleted values; skip over.
            } else if (Array.isArray(child)) {
              // It's a contiguous block of values.
              if (leftValueIndex < child.length) {
                // The neighbor is at leftIndex within child,
                // so our vars are all accurate. End the
                // left neighbor search.
                break leftNeighborSearch;
              }
              leftValueIndex -= child.length;
            } else {
              if (leftValueIndex < child.numValues) {
                // child contains the value, "recurse" by
                // going to the next outer loop iteration.
                leftWaypoint = child;
                break;
              }
              leftValueIndex -= child.numValues;
            }
          }
        }
      }
    }

    // Define our "right neighbor" to be the next (possibly
    // deleted) value to the right of our left neighbor.
    // If our right neighbor exists and is a descendant of
    // our left neighbor, then we become a left child of
    // our right neighbor; else we become a right child of
    // our left neighbor.
    // This way, it is guaranteed that our parent does not
    // already have a true child on the same side as us.

    // **Remark:** When list[index] is not a descendant of
    // list[index - 1], we technically can choose which
    // to use as a parent. If there are deleted values in
    // between those, we have even more choice: we can
    // attach to any of the deleted values.
    // For now, I am opting to use the preference order:
    //
    // 1. list[index - 1].
    // 2. (Possibly deleted) right neighbor of list[index - 1].
    //
    // This should generally lead to shorter paths
    // (in particular, if someone deletes the whole
    // text and then types at the beginning, this strategy
    // will use a root child as the parent instead of
    // the old rightmost character), and also avoids
    // weirdly spreading around nodes within a deleted
    // section. However, it has the
    // downside that in other lists that allow restoration,
    // if you repeatedly type and delete everything, then
    // restore all repeats, they will show up in RtL order
    // w.r.t. time, whereas I would prefer LtR.
    // So if we refactor things to use a balanced tree
    // (hence waypoint tree path lengths don't matter),
    // we should consider flipping the left/right preference.

    let trueIndex: number | undefined = undefined;
    if (
      index !== 0 && // exclude root case
      leftValueIndex < (<T[]>leftWaypoint.children[leftChildIndex]).length - 1
    ) {
      // Right neighbor is the next value in child.
      // Whether that is a descendant of the left neighbor
      // or vice-versa depends on which side of the center
      // we are on, i.e., the sign of left neighbor's
      // trueIndex.
      trueIndex = this.getTrueIndex(
        leftWaypoint,
        leftChildIndex,
        leftValueIndex
      );
      if (trueIndex >= 0) {
        return this.insertInternal(
          leftWaypoint,
          leftChildIndex,
          leftValueIndex + 1,
          "left",
          value
        );
      }
    } else if (leftChildIndex < leftWaypoint.children.length - 1) {
      const child = leftWaypoint.children[leftChildIndex + 1];
      // Right neighbor is the first value in child.
      if (typeof child === "number" || Array.isArray(child)) {
        // Right neighbor is the first (possibly deleted)
        // value counted by child.
        // Whether that is a descendant of the left neighbor
        // or vice-versa depends on which side of the center
        // we are on, i.e., the sign of left neighbor's
        // trueIndex.
        trueIndex = this.getTrueIndex(
          leftWaypoint,
          leftChildIndex,
          leftValueIndex
        );
        if (trueIndex >= 0) {
          return this.insertInternal(
            leftWaypoint,
            leftChildIndex + 1,
            0,
            "left",
            value
          );
        }
      } else {
        // child is a waypoint. It need not be
        // a descendant of left neighbor: it might be a
        // true child of some other value.
        trueIndex = this.getTrueIndex(
          leftWaypoint,
          leftChildIndex,
          leftValueIndex
        );
        if (trueIndex >= 0 && child.parentIndex >= trueIndex) {
          // child is indeed a descendant of leftNeighbor.
          return this.insertLeftmostDescendant(child, value);
        }
        // Else right neighbor is not a descendant of left neighbor;
        // fall through.
      }
    }
    // If we reach here, then right neighbor was not
    // a descendant of left neighbor (or didn't exist).
    return this.insertInternal(
      leftWaypoint,
      leftChildIndex,
      leftValueIndex,
      "right",
      value,
      trueIndex
    );
  }

  /**
   * Inserts value as a leftmost descendant of waypoint,
   * i.e., a left child of its current leftmost descendant.
   */
  private insertLeftmostDescendant(waypoint: Waypoint<T>, value: T): T {
    let curWaypoint = waypoint;
    for (;;) {
      const firstChild = curWaypoint.children[0];
      if (typeof firstChild === "number" || Array.isArray(firstChild)) {
        // The leftmost true child of curWaypoint is a value.
        // That is necessarily the leftmost descendant of
        // waypoint.
        return this.insertInternal(
          curWaypoint,
          0,
          0,
          "left",
          value,
          curWaypoint.startIndex
        );
      } else {
        // firstChild is a waypoint; "recurse".
        curWaypoint = firstChild;
      }
    }
  }

  /**
   * Assumes that the parent location has no (true)
   * children on childSide (including deleted values).
   */
  private insertInternal(
    parentWaypoint: Waypoint<T>,
    parentChildIndex: number,
    parentValueIndex: number,
    childSide: "left" | "right",
    value: T,
    trueParentIndex = this.getTrueIndex(
      parentWaypoint,
      parentChildIndex,
      parentValueIndex
    )
  ): T {
    const sign = childSide === "right" ? 1 : -1;
    let message: PrimitiveCListMessage;
    // Two options:
    //
    // 1. Make a new waypoint with the given parent and
    // (true) index, and with value at its index 0.
    // 2. Reuse parentWaypoint, putting value at
    // trueParentIndex + sign.
    //
    // Option 2 is preferred for efficiency, but it is only
    // allowed if:
    // - Our replica had also created parentWaypoint.
    // - The desired (waypoint, index) pair is not already used, equivalently, sign * trueParentIndex >= 0.
    //
    // Note that when using Option 2, we don't have to
    // worry that we are jumping over a true child
    // of (parentWaypoint, trueParentIndex) with a different
    // waypoint, because no such child exists by assumption.
    if (
      parentWaypoint !== this.rootWaypoint &&
      parentWaypoint.sender === this.runtime.replicaID &&
      sign * trueParentIndex >= 0
    ) {
      // Option 2.
      message = PrimitiveCListMessage.create({
        insertOpt: {
          counterAndSide: sign * parentWaypoint.counter,
          value: this.valueSerializer.serialize(value),
        },
      });
    } else {
      // Option 1.
      message = PrimitiveCListMessage.create({
        insertWaypoint: {
          counter: this.sendCounter++,
          parentWaypointSender:
            parentWaypoint.sender === this.runtime.replicaID
              ? undefined
              : parentWaypoint.sender,
          // Note if parent is the root, this will correctly
          // be 0, since the root's counter is 0.
          parentWaypointCounterAndSide: sign * parentWaypoint.counter,
          parentIndex: trueParentIndex,
          value: this.valueSerializer.serialize(value),
        },
      });
    }

    this.sendPrimitive(PrimitiveCListMessage.encode(message).finish());
    return value;
  }

  /**
   * Returns the (true) index within waypoint of the
   * (possibly deleted) value
   * at waypoint.children[childIndex][valueIndex].
   *
   * Child must be a T[] or number, not a waypoint.
   */
  private getTrueIndex(
    waypoint: Waypoint<T>,
    childIndex: number,
    valueIndex: number
  ): number {
    // Find the true index of the first value in child.
    let childStartIndex = waypoint.startIndex;
    for (let i = 0; i < childIndex; i++) {
      const childBefore = waypoint.children[i];
      if (typeof childBefore === "number") {
        childStartIndex += childBefore;
      } else if (Array.isArray(childBefore)) {
        childStartIndex += childBefore.length;
      }
      // Waypoint children don't contribute to the index.
    }
    return childStartIndex + valueIndex;
  }

  delete(startIndex: number, count = 1): void {
    if (startIndex < 0) {
      throw new Error(`startIndex out of bounds: ${startIndex}`);
    }
    if (startIndex + count > this.length) {
      throw new Error(
        `(startIndex + count) out of bounds: ${startIndex} + ${count} (length: ${this.length})`
      );
    }

    // Delete from back to front, so deletion indices
    // are the same as their original values.
    for (let i = startIndex + count - 1; i >= startIndex; i--) {
      // Delete i.
      // Not going to optimize these sequential gets
      // since we will support deleteRange directly instead.
      const [waypoint, childIndex, valueIndex] = this.getInternalLocation(i);
      const trueIndex = this.getTrueIndex(waypoint, childIndex, valueIndex);
      const message = PrimitiveCListMessage.create({
        delete: {
          waypointSender:
            waypoint.sender === this.runtime.replicaID
              ? undefined
              : waypoint.sender,
          // Note this is never 0: waypoint cannot be root,
          // since the root has no values to delete.
          waypointCounter: waypoint.counter,
          index: trueIndex,
        },
      });
      this.sendPrimitive(PrimitiveCListMessage.encode(message).finish());
    }
  }

  protected receivePrimitive(message: Message, meta: MessageMeta): void {
    // TODO: events
    const decoded = PrimitiveCListMessage.decode(<Uint8Array>message);
    switch (decoded.op) {
      case "insertOpt": {
        const value = this.valueSerializer.deserialize(
          decoded.insertOpt!.value
        );
        const counterAndSide = int64AsNumber(decoded.insertOpt!.counterAndSide);
        const waypoint = this.waypointsByID.get(meta.sender)![
          Math.abs(counterAndSide) - 1
        ];

        if (counterAndSide > 0) {
          // Right side: value has the next positive (true) index.
          // Any child to the right of our (true) parent
          // - the current last value in waypoint -
          // must be either causally to our right, or
          // a concurrent insertion; since we order concurrent
          // true children so that the waypoint's
          // sender's values bind to the center, the
          // latter are also to our right.
          // Thus we always insert directly to the right
          // of our true parent, i.e., after waypoint's
          // current last value.
          for (
            let childIndex = waypoint.children.length - 1;
            childIndex >= 0;
            childIndex--
          ) {
            const child = waypoint.children[childIndex];
            if (typeof child === "number") {
              // Our true parent was deleted.
              // Splice in a new T[] child after child.
              waypoint.children.splice(childIndex + 1, 0, [value]);
              break;
            } else if (Array.isArray(child)) {
              // Our true parent is the last element in child.
              // Append to it.
              child.push(value);
              break;
            }
            // Else child is a waypoint to our right;
            // skip over it.
          }
          // Because each waypoint must have at least one
          // value (possibly deleted), the above loop will
          // actually insert value at some point.
        } else {
          // Left side: value has the next negative (true) index.
          // Similar to right side, we always insert directly
          // to the left of our true parent, i.e., before
          // waypoint's current first value.
          for (
            let childIndex = 0;
            childIndex < waypoint.children.length;
            childIndex++
          ) {
            const child = waypoint.children[childIndex];
            if (typeof child === "number") {
              // Our true parent was deleted.
              // Splice in a new T[] child before child.
              waypoint.children.splice(childIndex, 0, [value]);
              break;
            } else if (Array.isArray(child)) {
              // Our true parent is the first element in child.
              // Unshift to it.
              child.unshift(value);
              break;
            }
            // Else child is a waypoint to our left;
            // skip over it.
          }
          // Because each waypoint must have at least one
          // value (possibly deleted), the above loop will
          // actually insert value at some point.

          // Update startIndex.
          waypoint.startIndex--;
        }

        // Update numValues for waypoint and its ancestors.
        let curWaypoint: Waypoint<T> | null = waypoint;
        while (curWaypoint !== null) {
          curWaypoint.numValues++;
          curWaypoint = curWaypoint.parentWaypoint;
        }
        break;
      }
      case "insertWaypoint": {
        const value = this.valueSerializer.deserialize(
          decoded.insertWaypoint!.value
        );
        const counter = int64AsNumber(decoded.insertWaypoint!.counter);
        const parentWaypointSender = Object.prototype.hasOwnProperty.call(
          decoded.insertWaypoint!,
          "parentWaypointSender"
        )
          ? decoded.insertWaypoint!.parentWaypointSender!
          : meta.sender;
        const parentWaypointCounterAndSide = int64AsNumber(
          decoded.insertWaypoint!.parentWaypointCounterAndSide
        );
        const parentIndex = decoded.insertWaypoint!.parentIndex;

        const parentWaypoint =
          parentWaypointCounterAndSide === 0
            ? this.rootWaypoint
            : this.waypointsByID.get(parentWaypointSender)![
                Math.abs(parentWaypointCounterAndSide) - 1
              ];
        if (parentWaypoint === undefined) {
          throw new Error("parentWaypoint not found");
        }

        const newWaypoint = new Waypoint(
          meta.sender,
          counter,
          parentWaypoint,
          parentIndex
        );
        newWaypoint.children.push([value]);

        // Store newWaypoint in waypointsByID.
        if (counter === 1) {
          this.waypointsByID.set(meta.sender, [newWaypoint]);
        } else {
          this.waypointsByID.get(meta.sender)!.push(newWaypoint);
        }

        // Store newWaypoint in parentWaypoint.children, in order.
        // Our true parent is (parentWaypoint, parentIndex),
        // and we are on side: R iff parentWaypointCounterAndSide >= 0.
        // (0 case is when parentWaypoint is the root.)
        // Ties between values/waypoints with the same true parent
        // and side are broken by:
        // - Values with the same waypoint bind towards its center
        // (index 0).
        // - Waypoints are sorted lexicographically by sender.

        const side = parentWaypointCounterAndSide >= 0 ? "right" : "left";

        // First find parentIndex within parentWaypoint.children.
        let childIndex = 0;
        let valueIndex = parentIndex - parentWaypoint.startIndex;
        for (; childIndex < parentWaypoint.children.length; childIndex++) {
          const child = parentWaypoint.children[childIndex];
          if (typeof child === "number") {
            if (valueIndex < child) break;
            valueIndex -= child;
          } else if (Array.isArray(child)) {
            if (valueIndex < child.length) break;
            valueIndex -= child.length;
          } // else Waypoint child; skip.
        }
        if (childIndex === parentWaypoint.children.length) {
          throw new Error(`parentIndex too large: ${parentIndex}`);
        }
        const child = parentWaypoint.children[childIndex];

        // Now do cases depending on the type of child.
        if (typeof child === "number" || Array.isArray(child)) {
          const length = typeof child === "number" ? child : child.length;
          if (side === "left" && valueIndex === 0) {
            // We're before the first value represented by
            // this delete entry.
            parentWaypoint.children.splice(childIndex, 0, newWaypoint);
          } else if (side === "right" && valueIndex === length - 1) {
            // We're after the last value.
            parentWaypoint.children.splice(childIndex + 1, 0, newWaypoint);
          } else {
            // We split the child.
            const onOurLeft = side === "left" ? valueIndex : valueIndex + 1;
            if (typeof child === "number") {
              parentWaypoint.children.splice(
                childIndex,
                1,
                onOurLeft,
                newWaypoint,
                child - onOurLeft
              );
            } else {
              parentWaypoint.children.splice(
                childIndex,
                1,
                child.slice(0, onOurLeft),
                newWaypoint,
                child.slice(onOurLeft)
              );
            }
          }
        } else {
          // Eue to the tiebreaker rule favoring parentWaypoint.sender's
          // own values, we know that we are not in the middle
          // of this waypoint child, but instead a new
          // child adjacent to it, closer to the center.
          const newWaypointChildIndex =
            parentWaypointCounterAndSide >= 0 ? childIndex + 1 : childIndex;
          parentWaypoint.children.splice(newWaypointChildIndex, 0, newWaypoint);
        }

        // Update numValues for waypoint and its ancestors.
        let curWaypoint: Waypoint<T> | null = newWaypoint;
        while (curWaypoint !== null) {
          curWaypoint.numValues++;
          curWaypoint = curWaypoint.parentWaypoint;
        }
        break;
      }
      case "delete": {
        const waypointCounter = int64AsNumber(decoded.delete!.waypointCounter);
        const waypointSender = Object.prototype.hasOwnProperty.call(
          decoded.delete!,
          "waypointSender"
        )
          ? decoded.delete!.waypointSender!
          : meta.sender;
        const waypoint =
          this.waypointsByID.get(waypointSender)![waypointCounter - 1];
        if (waypoint === undefined) {
          throw new Error("waypoint not found");
        }

        // Find index within waypoint.children.
        let childIndex = 0;
        let valueIndex = decoded.delete!.index - waypoint.startIndex;
        for (; childIndex < waypoint.children.length; childIndex++) {
          const child = waypoint.children[childIndex];
          if (typeof child === "number") {
            if (valueIndex < child) break;
            valueIndex -= child;
          } else if (Array.isArray(child)) {
            if (valueIndex < child.length) break;
            valueIndex -= child.length;
          } // else Waypoint child; skip.
        }
        if (childIndex === waypoint.children.length) {
          throw new Error(`index too large: ${decoded.delete!.index}`);
        }

        const child = <T[] | number>waypoint.children[childIndex];
        if (Array.isArray(child)) {
          // Delete child[valueIndex], possibly splitting
          // child's array, and replace the value with a number.
          if (valueIndex === 0 && child.length === 1) {
            // Delete child, maybe merging the new 1
            // with adjacent numbers.
            const leftIsNumber =
              childIndex > 0 &&
              typeof waypoint.children[childIndex - 1] === "number";
            const rightIsNumber =
              childIndex > 0 &&
              typeof waypoint.children[childIndex + 1] === "number";
            if (!leftIsNumber && !rightIsNumber) {
              // No merging.
              waypoint.children[childIndex] = 1;
            } else if (leftIsNumber && rightIsNumber) {
              // Double merge.
              const newNumber =
                <number>waypoint.children[childIndex - 1] +
                1 +
                <number>waypoint.children[childIndex + 1];
              waypoint.children.splice(childIndex - 1, 3, newNumber);
            } else if (leftIsNumber) {
              // Left merge.
              const newNumber = <number>waypoint.children[childIndex - 1] + 1;
              waypoint.children.splice(childIndex - 1, 2, newNumber);
            } else {
              // Right merge.
              const newNumber = <number>waypoint.children[childIndex + 1] + 1;
              waypoint.children.splice(childIndex, 2, newNumber);
            }
          } else if (valueIndex === 0) {
            // Delete the first value only.
            child.shift();
            if (
              childIndex !== 0 &&
              typeof waypoint.children[childIndex - 1] === "number"
            ) {
              (<number>waypoint.children[childIndex - 1])++;
            } else {
              waypoint.children.splice(childIndex, 0, 1);
            }
          } else if (valueIndex === child.length - 1) {
            // Delete the last value only.
            child.pop();
            if (
              childIndex !== waypoint.children.length - 1 &&
              typeof waypoint.children[childIndex + 1] === "number"
            ) {
              (<number>waypoint.children[childIndex + 1])++;
            } else {
              waypoint.children.splice(childIndex + 1, 0, 1);
            }
          } else {
            // Delete valueIndex in the middle, splitting the array.
            waypoint.children.splice(
              childIndex,
              1,
              child.slice(0, valueIndex),
              1,
              child.slice(valueIndex + 1)
            );
          }

          // Update numValues for waypoint and its ancestors.
          let curWaypoint: Waypoint<T> | null = waypoint;
          while (curWaypoint !== null) {
            curWaypoint.numValues--;
            curWaypoint = curWaypoint.parentWaypoint;
          }
        } // else already deleted.
        break;
      }
      default:
        throw new Error(`Unrecognized decoded.op: ${decoded.op}`);
    }
    // this.printTreeWalk();
  }

  /**
   * index must be valid; else may infinite loop.
   *
   * The indicated child will always be a T[], since
   * we only consider present values.
   */
  private getInternalLocation(
    index: number
  ): [waypoint: Waypoint<T>, childIndex: number, valueIndex: number] {
    let curWaypoint = this.rootWaypoint;
    // Thanks to checkIndex, we are guaranteed that we
    // will find the value, so an infinite loop is safe.
    for (;;) {
      // Walk the children of curWaypoint.
      for (
        let childIndex = 0;
        childIndex < curWaypoint.children.length;
        childIndex++
      ) {
        const child = curWaypoint.children[childIndex];
        if (typeof child === "number") {
          // Deleted values; skip over.
        } else if (Array.isArray(child)) {
          // It's a contiguous block of values.
          if (index < child.length) {
            // Found the value; return.
            return [curWaypoint, childIndex, index];
          }
          index -= child.length;
        } else {
          if (index < child.numValues) {
            // child contains the value, "recurse" by
            // going to the next outer loop iteration.
            curWaypoint = child;
            break;
          }
          index -= child.numValues;
        }
      }
    }
  }

  get(index: number): T {
    this.checkIndex(index);

    const [waypoint, childIndex, valueIndex] = this.getInternalLocation(index);
    return (<T[]>waypoint.children[childIndex])[valueIndex];
  }

  *values(): IterableIterator<T> {
    // Walk the tree.
    const stack: [waypoint: Waypoint<T>, childIndex: number][] = [];
    let waypoint = this.rootWaypoint;
    let childIndex = 0;
    for (;;) {
      if (childIndex === waypoint.children.length) {
        // Done with this waypoint; pop the stack.
        if (stack.length === 0) {
          // Completely done.
          return;
        }
        [waypoint, childIndex] = stack.pop()!;
        childIndex++;
        continue;
      }

      const child = waypoint.children[childIndex];
      if (typeof child === "number") {
        // Deleted values; skip.
      } else if (Array.isArray(child)) {
        // Yield all values.
        yield* child;
      } else {
        // Waypoint child. Recurse if nonempty, else skip.
        if (child.numValues > 0) {
          stack.push([waypoint, childIndex]);
          waypoint = child;
          childIndex = 0;
          continue;
        }
      }

      // Move to the next child.
      childIndex++;
    }
  }

  // TODO: remove/private
  printTreeWalk() {
    // Walk the tree.
    console.log("Tree walk by " + this.runtime.replicaID);
    const stack: [waypoint: Waypoint<T>, childIndex: number][] = [];
    let waypoint = this.rootWaypoint;
    let childIndex = 0;
    console.log("Root:");
    process.stdout.write("  ");
    for (;;) {
      if (childIndex === waypoint.children.length) {
        // Done with this waypoint; pop the stack.
        console.log("");
        if (stack.length === 0) {
          // Completely done.
          return;
        }
        [waypoint, childIndex] = stack.pop()!;
        childIndex++;
        for (let i = 0; i < stack.length + 1; i++) {
          process.stdout.write("  ");
        }
        continue;
      }

      const child = waypoint.children[childIndex];
      if (typeof child === "number") {
        process.stdout.write(child + ", ");
      } else if (Array.isArray(child)) {
        process.stdout.write(JSON.stringify(child) + ", ");
      } else {
        // Waypoint child. Recurse.
        process.stdout.write("\n");
        for (let i = 0; i < stack.length + 1; i++) {
          process.stdout.write("  ");
        }
        stack.push([waypoint, childIndex]);
        waypoint = child;
        childIndex = 0;
        process.stdout.write(
          "[" +
            waypoint.sender +
            ", " +
            waypoint.counter +
            "], " +
            waypoint.startIndex +
            ":\n"
        );
        for (let i = 0; i < stack.length + 1; i++) {
          process.stdout.write("  ");
        }
        continue;
      }

      // Move to the next child.
      childIndex++;
    }
  }

  private checkIndex(index: number) {
    if (index < 0 || index >= this.length) {
      throw new Error(`index out of bounds: ${index} (length: ${this.length})`);
    }
  }

  get length(): number {
    return this.rootWaypoint.numValues;
  }

  // Override alias insert methods so we can accept
  // bulk values.

  push(value: T): T;
  push(...values: T[]): T | undefined;
  push(...values: T[]): T | undefined {
    return this.insert(this.length, ...values);
  }

  unshift(value: T): T;
  unshift(...values: T[]): T | undefined;
  unshift(...values: T[]): T | undefined {
    return this.insert(0, ...values);
  }

  splice(startIndex: number, deleteCount?: number, ...values: T[]): void {
    // Sanitize deleteCount
    if (deleteCount === undefined || deleteCount > this.length - startIndex)
      deleteCount = this.length - startIndex;
    else if (deleteCount < 0) deleteCount = 0;
    // Delete then insert
    this.delete(startIndex, deleteCount);
    if (values.length > 0) {
      this.insert(startIndex, ...values);
    }
  }

  slice(start?: number, end?: number): T[] {
    // Optimize common case (slice())
    if (start === undefined && end === undefined) {
      return [...this.values()];
    } else return super.slice(start, end);
  }

  getLocation(index: number): string {
    throw new Error("Method not implemented.");
  }

  locationEntries(): IterableIterator<[string, T]> {
    throw new Error("Method not implemented.");
  }

  save(): Uint8Array {
    throw new Error("Method not implemented.");
  }

  load(saveData: Optional<Uint8Array>): void {
    if (saveData.isPresent) {
      throw new Error("Method not implemented.");
    }
  }

  canGC(): boolean {
    return false;
  }

  reset(): void {
    throw new Error("Method not implemented.");
  }
}
