#!/usr/bin/env python3
"""Execute the production sheet collectors/projections without a host or Provider."""
from pathlib import Path
import argparse
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
sheets = root / 'apps/ios/ScryRemote/Sheets'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--question-source', type=Path, default=sheets / 'RemoteQuestionSheet.swift')
parser.add_argument('--overview-source', type=Path, default=sheets / 'SessionOverviewSheet.swift')
args = parser.parse_args()
question = args.question_source.read_text()
collector = question[question.index('  private var complete:'):question.index('  var body:')].replace('private var', 'var')
model = (sheets / 'ModelEffortPopover.swift').read_text()
efforts = model[model.index('  private var activeEfforts:'):model.index('  var body:')].replace('private var', 'var')
overview = args.overview_source.read_text()
turn = overview[overview.index('struct SessionOverviewTurn {'):overview.index('struct SessionOverviewSheet:')]
transport = (root / 'experiments/remote-g0/swift/Sources/RemoteTransport/Transport.swift').read_text()
question_types = transport[transport.index('  public struct RunQuestionOption:'):transport.index('  public struct RunQuestionResponse:')]
control_types = transport[transport.index('  public struct RunControlOption:'):transport.index('  // A selectable Provider context.')]
copy = (sheets / 'SheetCopy.swift').read_text()
shared_copy = (root / 'apps/ios/ScryRemote/ConnectionCopy.swift').read_text()
last_checked = next(line for line in shared_copy.splitlines() if line.startswith('  static let historyLastChecked ='))
copy = 'enum ConnectionCopy {\n' + last_checked + '\n}\n' + copy
fixtures = r'''
struct QuestionCollector {
  var request: G0Transport.RunQuestionRequest
  var answers: [String: String] = [:]
  var selections: [String: Set<String>] = [:]
  COLLECTOR
}
struct EffortProjection {
  var modelOptions: [G0Transport.RunModelOption]
  var selectedModelId: String?
  var effortOptions: [G0Transport.RunControlOption]
  EFFORTS
}
@MainActor final class RemoteRunStore {
  enum Lifecycle { case running, unknown, settled, failed, cancelled }
  struct CompletedLiveTurn { let prompt: String; let resultSummary: String? }
  var prompt: String? = "Actual prompt"
  var lifecycle = Lifecycle.unknown
  var resultSummary: String?
  var terminalLifecycleKnown: Bool { [.settled, .failed, .cancelled].contains(lifecycle) }
}
var count = 0
@MainActor func check(_ condition: Bool, _ label: String) {
  guard condition else { print("FAIL \(label)"); exit(1) }
  count += 1; print("PASS \(label)")
}
func request(multi: Bool = false, text: Bool = false, second: Bool = false) -> G0Transport.RunQuestionRequest {
  let prompt = """
  {"header":"范围","question":"选择工作","multiSelect":\(multi),
   "inputMode":\(text ? "\"multiline\"" : "null"),
   "options":[{"label":"测试","description":"test"},{"label":"文档","description":"docs"},{"label":"兼容性","description":"compat"}]}
  """
  let extra = second ? #",{"header":"说明","question":"说明原因","multiSelect":false,"inputMode":"text","options":[]}"# : ""
  let json = """
  {"runId":"fixture","questionId":"question","questions":[\(prompt)\(extra)]}
  """
  return try! JSONDecoder().decode(G0Transport.RunQuestionRequest.self, from: Data(json.utf8))
}
var single = QuestionCollector(request: request())
check(!single.complete, "unanswered single choice is incomplete")
single.answers["选择工作"] = "文档"
check(single.complete && single.resolvedAnswers == ["选择工作":"文档"], "single choice uses the original label")
var multi = QuestionCollector(request: request(multi: true))
check(!multi.complete, "unanswered multiple choice is incomplete")
multi.selections["选择工作"] = ["兼容性", "测试"]
check(multi.complete && multi.resolvedAnswers["选择工作"] == "测试, 兼容性", "multiple answers follow option order, not set order")
multi.selections["选择工作"] = []
check(!multi.complete, "deselecting every option disables submission")
var text = QuestionCollector(request: request(text: true))
text.answers["选择工作"] = " \n "
check(!text.complete, "whitespace-only text is incomplete")
text.answers["选择工作"] = "  保留权限边界\n不变  "
check(text.complete && text.resolvedAnswers["选择工作"] == "  保留权限边界\n不变  ", "text payload is not trimmed or rewritten")
var both = QuestionCollector(request: request(second: true), answers: ["选择工作":"测试"])
check(!both.complete, "every question must be answered")
both.answers["说明原因"] = "回归检查"
check(both.complete && both.resolvedAnswers.count == 2, "all original question keys survive")
let fallback = [G0Transport.RunControlOption(id: "fallback", label: "Fallback")]
let scoped = [G0Transport.RunControlOption(id: "high", label: "High")]
let options = [G0Transport.RunModelOption(id: "a", label: "A", efforts: scoped),
               G0Transport.RunModelOption(id: "b", label: "B", efforts: [])]
var controls = EffortProjection(modelOptions: options, selectedModelId: options[0].selectionId, effortOptions: fallback)
check(controls.activeEfforts == scoped, "selected model efforts take precedence")
controls.selectedModelId = options[1].selectionId
check(controls.activeEfforts == fallback, "empty model efforts use the supplied fallback")
controls.selectedModelId = nil
check(controls.activeEfforts == fallback, "automatic model preserves fallback efforts")
controls.effortOptions = []
check(controls.activeEfforts.isEmpty, "missing efforts remain empty")
let run = RemoteRunStore()
run.resultSummary = "输入 18,420 · 输出 1,286 · $0.084"
check(SessionOverviewTurn.focused(run).resultSummary == nil, "unconfirmed result summary is hidden")
run.lifecycle = .running
check(SessionOverviewTurn.focused(run).running && SessionOverviewTurn.focused(run).resultSummary == nil, "running evidence is not a completed usage result")
for state in [RemoteRunStore.Lifecycle.settled, .failed, .cancelled] {
  run.lifecycle = state
  let result = SessionOverviewTurn.focused(run)
  check(!result.running && result.resultSummary == run.resultSummary, "terminal result summary is verbatim: \(state)")
}
check(SessionOverviewTurn.completed(.init(prompt: "P", resultSummary: nil)).resultSummary == nil, "missing completed usage is not zero")
check(SessionOverviewTurn(prompt: "Archived").resultSummary == nil, "archive-only turn has no invented summary")
check(SheetCopy.context(title: nil, provider: "Codex") == "Codex", "missing title shows provider only")
check(SheetCopy.context(title: "会话", provider: "Codex") == "会话 · Codex", "caller context is preserved")
print("\(count) sheet-contract checks passed")
'''.replace('COLLECTOR', collector).replace('EFFORTS', efforts)
with tempfile.TemporaryDirectory(prefix='scry-sheet-contracts-') as temporary:
    directory = Path(temporary)
    main = directory / 'main.swift'
    main.write_text('import Foundation\nenum G0Transport {\n' + question_types + control_types + '\n}\n' + turn + copy + fixtures)
    # Foundation-only contracts can run directly in the installed Swift toolchain;
    # they do not need a separately signed, temporary executable.
    subprocess.run(['xcrun', 'swift', '-swift-version', '6', str(main)], check=True)
