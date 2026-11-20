import sys

import pyatspi


def find(root, name, invoke):
    # The desktop may expose other applications. Only traverse the child's tree.
    for element in root:
        try:
            if element.name == name and element.getState().contains(pyatspi.STATE_SHOWING):
                if not invoke:
                    return True
                if element.getState().contains(pyatspi.STATE_ENABLED):
                    action = element.queryAction()
                    for index in range(action.nActions):
                        if action.getName(index) in ('click', 'press', 'activate'):
                            return action.doAction(index)
        except (NotImplementedError, RuntimeError):
            pass
        if find(element, name, invoke):
            return True
    return False


pid, label, operation = sys.argv[1:]
for app in pyatspi.Registry.getDesktop(0):
    if app.get_process_id() == int(pid) and find(app, label, operation == 'invoke'):
        sys.exit(0)
sys.exit(2)
