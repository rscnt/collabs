import {
  setFolder,
  setRecordedTrials,
  setVersion,
  setWarmupTrials,
} from "./record";
import { AutomergeMap } from "./replica-benchmark/implementations/automerge/map";
import { AutomergeVariable } from "./replica-benchmark/implementations/automerge/variable";
import { AutomergeText } from "./replica-benchmark/implementations/automerge/text";
import { AutomergeTodoList } from "./replica-benchmark/implementations/automerge/todo_list";
import { CollabsTodoList } from "./replica-benchmark/implementations/collabs/todo_list";
// import { CollabsJSONOptTodoList } from "./replica-benchmark/implementations/collabs/json_opt_todo_list";
import { CollabsJSONTextTodoList } from "./replica-benchmark/implementations/collabs/json_text_todo_list";
import { CollabsJSONTodoList } from "./replica-benchmark/implementations/collabs/json_todo_list";
import { CollabsMap } from "./replica-benchmark/implementations/collabs/map";
import { CollabsVariable } from "./replica-benchmark/implementations/collabs/variable";
import { CollabsText } from "./replica-benchmark/implementations/collabs/text";
import { YjsMap } from "./replica-benchmark/implementations/yjs/map";
import { YjsVariable } from "./replica-benchmark/implementations/yjs/variable";
import { YjsText } from "./replica-benchmark/implementations/yjs/text";
import { YjsTodoList } from "./replica-benchmark/implementations/yjs/todo_list";
import {
  Implementation,
  Mode,
  ReplicaBenchmark,
  Trace,
} from "./replica-benchmark/replica_benchmark";
import { MicroMapRollingTrace } from "./replica-benchmark/traces/micro_map_rolling_trace";
import { MicroMapTrace } from "./replica-benchmark/traces/micro_map_trace";
import { MicroVariableTrace } from "./replica-benchmark/traces/micro_variable_trace";
import { MicroTextLtrTrace } from "./replica-benchmark/traces/micro_text_ltr_trace";
import { MicroTextRandomTrace } from "./replica-benchmark/traces/micro_text_random_trace";
import { RealTextTrace } from "./replica-benchmark/traces/real_text_trace";
import { TodoListTrace } from "./replica-benchmark/traces/todo_list_trace";
import { CollabsNoop } from "./replica-benchmark/implementations/collabs/noop";
import { CollabsNestedNoop } from "./replica-benchmark/implementations/collabs/nested_noop";
import { NoopTrace } from "./replica-benchmark/traces/noop_trace";
import { CollabsRichTextWithCursor } from "./replica-benchmark/implementations/collabs/rich_text_with_cursor";
import { CollabsTextWithCursor } from "./replica-benchmark/implementations/collabs/text_with_cursor";
import { YjsTextWithCursor } from "./replica-benchmark/implementations/yjs/text_with_cursor";
import { AutomergeTextWithCursor } from "./replica-benchmark/implementations/automerge/text_with_cursor";

const traces: { [name: string]: Trace<unknown> } = {
  MicroMapRolling: new MicroMapRollingTrace(),
  MicroMap: new MicroMapTrace(),
  MicroVariable: new MicroVariableTrace(),
  MicroTextLtr: new MicroTextLtrTrace(),
  MicroTextRandom: new MicroTextRandomTrace(),
  RealText: new RealTextTrace(),
  TodoList: new TodoListTrace(),
  Noop: new NoopTrace(),
};

const implementations: { [name: string]: Implementation<unknown> } = {
  AutomergeMap: AutomergeMap,
  AutomergeVariable: AutomergeVariable,
  AutomergeText: AutomergeText,
  AutomergeTextWithCursor: AutomergeTextWithCursor,
  AutomergeTodoList: AutomergeTodoList,
  // For Collabs, we have two versions of each benchmark:
  // a default version that enforces causal ordering, and a
  // CG ("causality guaranteed") version that does not, i.e., it
  // assumes the network guarantees causal ordering.
  CollabsTodoList: CollabsTodoList(false),
  CollabsCGTodoList: CollabsTodoList(true),
  // CollabsJSONOptTodoList: CollabsJSONOptTodoList,
  CollabsJSONTextTodoList: CollabsJSONTextTodoList(false),
  CollabsCGJSONTextTodoList: CollabsJSONTextTodoList(true),
  CollabsJSONTodoList: CollabsJSONTodoList(false),
  CollabsCGJSONTodoList: CollabsJSONTodoList(true),
  CollabsMap: CollabsMap(false),
  CollabsCGMap: CollabsMap(true),
  CollabsVariable: CollabsVariable(false),
  CollabsCGVariable: CollabsVariable(true),
  CollabsRichTextWithCursor: CollabsRichTextWithCursor(false),
  CollabsCGRichTextWithCursor: CollabsRichTextWithCursor(true),
  CollabsText: CollabsText(false),
  CollabsCGText: CollabsText(true),
  CollabsTextWithCursor: CollabsTextWithCursor(false),
  CollabsCGTextWithCursor: CollabsTextWithCursor(true),
  CollabsNoop: CollabsNoop(false),
  CollabsCGNoop: CollabsNoop(true),
  CollabsNestedNoop: CollabsNestedNoop(false),
  CollabsCGNestedNoop: CollabsNestedNoop(true),
  YjsMap: YjsMap,
  YjsVariable: YjsVariable,
  YjsText: YjsText,
  YjsTextWithCursor: YjsTextWithCursor,
  YjsTodoList: YjsTodoList,
};

(async function () {
  function printUsage(exitCode: number) {
    console.log(`Usage: npm start -- <out folder> <version> <warmup trials> <recorded trials> <measurement> <trace> <implementation> <mode>
If <recorded trials> is 0, no output is recorded.
You can set both trial counts to 0 to do a test run (check that test names and args are valid without running the actual experiments).
`);
    process.exit(exitCode);
  }

  const args = process.argv.slice(2);
  if (args.length !== 8) {
    console.log("Wrong number of arguments");
    printUsage(100);
  }

  setFolder(args[0]);
  setVersion(args[1]);
  setWarmupTrials(Number.parseInt(args[2]));
  setRecordedTrials(Number.parseInt(args[3]));

  const traceName = args[5];
  const trace = traces[traceName];
  if (trace === undefined) {
    console.log("Unrecognized trace: " + args[5]);
    printUsage(5);
  }

  const implementationName = args[6];
  const implementation = implementations[implementationName];
  if (implementation === undefined) {
    console.log("Unrecognized implementation: " + args[6]);
    printUsage(6);
  }

  const replicaBenchmark = new ReplicaBenchmark<unknown>(
    trace,
    traceName,
    implementation,
    implementationName
  );

  const mode = <Mode>args[7];
  if (!(mode === "single" || mode === "rotate" || mode === "concurrent")) {
    console.log(
      "Invalid mode (expected: single | rotate | concurrent): " + mode
    );
    printUsage(7);
  }

  const measurement = args[4];
  switch (measurement) {
    case "sendTime":
      if (mode !== "single") {
        throw new Error('sendTime only supports "single" mode');
      }
      await replicaBenchmark.sendTimeSingle();
      break;
    case "sendMemory":
      if (mode !== "single") {
        throw new Error('sendTime only supports "single" mode');
      }
      await replicaBenchmark.sendMemorySingle();
      break;
    case "receiveNetwork": {
      const [msgs, finalState] = await replicaBenchmark.getSentMessages(mode);
      await replicaBenchmark.receiveNetwork(mode, msgs, finalState);
      break;
    }
    case "receiveTime": {
      const [msgs, finalState] = await replicaBenchmark.getSentMessages(mode);
      await replicaBenchmark.receiveTime(mode, msgs, finalState);
      break;
    }
    case "receiveMemory": {
      const [msgs, finalState] = await replicaBenchmark.getSentMessages(mode);
      await replicaBenchmark.receiveMemory(mode, msgs, finalState);
      break;
    }
    case "receiveSave": {
      const [msgs, finalState] = await replicaBenchmark.getSentMessages(mode);
      await replicaBenchmark.receiveSave(mode, msgs, finalState);
      break;
    }
    case "receiveAll": {
      // All receive benchmarks, with a single call to getSentMessages
      // to save time.
      const [msgs, finalState] = await replicaBenchmark.getSentMessages(mode);
      await replicaBenchmark.receiveNetwork(mode, msgs, finalState);
      await replicaBenchmark.receiveTime(mode, msgs, finalState);
      await replicaBenchmark.receiveMemory(mode, msgs, finalState);
      await replicaBenchmark.receiveSave(mode, msgs, finalState);
      break;
    }
    default:
      console.log("Unrecognized measurement: " + measurement);
      printUsage(4);
  }
})();
