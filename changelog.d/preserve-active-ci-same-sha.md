Fix Central CI concurrency so a duplicate request for the same repository and head SHA does not cancel already-running tests; retain GitHub's built-in one-running/one-pending grouping.
