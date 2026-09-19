mergeInto(LibraryManager.library, {
  LastMileDispatch: function (jsonPointer) {
    try {
      var detail = JSON.parse(UTF8ToString(jsonPointer));
      window.dispatchEvent(new CustomEvent('last-mile-unity', { detail: detail }));
    } catch (error) {
      console.error('[Last Mile Unity bridge]', error);
    }
  }
});
