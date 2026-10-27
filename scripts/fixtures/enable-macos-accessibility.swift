import ApplicationServices
import Foundation

// Only the isolated Electron fixture's PID is supplied by the parent test.
// Exercise the same native activation that can bypass disable-renderer-accessibility.
guard CommandLine.arguments.count == 3, let pid = pid_t(CommandLine.arguments[1]) else {
  fatalError("Expected the owned fixture PID and composer label")
}
let composerLabel = CommandLine.arguments[2]
guard AXIsProcessTrusted() else {
  fputs("Native AX check unavailable: grant Accessibility permission to the test runner.\n", stderr)
  exit(2)
}
let application = AXUIElementCreateApplication(pid)
let activation = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
guard activation == .success else {
  fputs("Native AX activation failed: \(activation.rawValue)\n", stderr)
  exit(1)
}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
func readTree() -> (nodes: Int, complete: Bool, buttons: Int, text: Int, fields: Int) {
  var queue = attribute(application, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
  var index = 0
  var buttons = 0
  var text = 0
  var fields = 0
  while index < queue.count && index < 10_000 {
    let element = queue[index]
    index += 1
    let role = attribute(element, kAXRoleAttribute as CFString) as? String
    let label = attribute(element, kAXDescriptionAttribute as CFString) as? String
      ?? attribute(element, kAXTitleAttribute as CFString) as? String ?? ""
    let value = attribute(element, kAXValueAttribute as CFString) as? String ?? ""
    if role == kAXButtonRole as String && !label.isEmpty { buttons += 1 }
    if role == kAXStaticTextRole as String && !value.isEmpty {
      text += 1
    }
    if (role == kAXTextFieldRole as String || role == kAXTextAreaRole as String) && label == composerLabel {
      var settable: DarwinBoolean = false
      if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue {
        fields += 1
      }
    }
    queue.append(contentsOf: attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? [])
  }
  return (index, index == queue.count, buttons, text, fields)
}
// A recreated renderer can have a committed DOM before its native AX tree arrives.
// Wait for the observable tree; do not dispatch activation again or assume DOM == AX.
let deadline = Date().addingTimeInterval(5)
var tree = readTree()
while tree.complete && (tree.buttons == 0 || tree.text == 0 || tree.fields == 0) && Date() < deadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  tree = readTree()
}
guard tree.complete, tree.buttons > 0, tree.text > 0, tree.fields > 0 else {
  fputs("Native AX tree incomplete: \(tree)\n", stderr)
  exit(1)
}
print("Native AX readable: \(tree)")
