class Slimy_CueTimer:
    """
    A UI node that displays a real-time elapsed timer during cue execution.
    Starts counting when the queue begins, stops when it finishes.
    Display-only node with no outputs.
    """

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "prompt": "PROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "execute"

    OUTPUT_NODE = True
    CATEGORY = "Slimy/Utils"

    def execute(self, **kwargs):
        return {}


NODE_CLASS_MAPPINGS = {
    "Slimy_CueTimer": Slimy_CueTimer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Slimy_CueTimer": "Slimy_CueTimer",
}
