// The layout file label-fit seeds: every pane at width 0, so the app's layout
// reader clamps each to its minimum and the labels are checked at their tightest.
// Its own module so the app's tests can check the app accepts it.
export const LABEL_FIT_LAYOUT = { layout: { jobsWidth: 0, statusWidth: 0, recordsListWidth: 0 } };
