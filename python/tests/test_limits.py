"""Unit tests for upload-size limits and batch planning.

Pure functions only: no client, no files, no network. Sizes are plain integers,
so these run instantly and stay readable.
"""

from __future__ import annotations

import pytest

from image2ppt import (
    BATCH_TARGET_BYTES,
    MAX_PAGES_PER_JOB,
    MAX_UPLOAD_BYTES,
    InvalidFileError,
    TooManySlidesError,
    UploadItem,
    check_submission,
    plan_batches,
)


def img(name: str, size: int = 1) -> UploadItem:
    return UploadItem(path=name, size=size, is_pdf=False)


def pdf(name: str, size: int = 1) -> UploadItem:
    return UploadItem(path=name, size=size, is_pdf=True)


def names(batches):
    """Batches as lists of file names, so assertions read like the input."""
    return [[item.path for item in batch] for batch in batches]


# --------------------------------------------------------------------------- #
# check_submission — the pre-flight gate
# --------------------------------------------------------------------------- #
def test_check_accepts_a_submission_at_both_limits():
    check_submission(MAX_UPLOAD_BYTES, MAX_PAGES_PER_JOB)  # exactly at the cap: fine


def test_check_rejects_one_byte_over_the_size_cap():
    with pytest.raises(InvalidFileError) as exc:
        check_submission(MAX_UPLOAD_BYTES + 1, 1)
    assert exc.value.code == "PAYLOAD_TOO_LARGE"


def test_check_rejects_one_page_over_the_page_cap():
    with pytest.raises(TooManySlidesError) as exc:
        check_submission(1, MAX_PAGES_PER_JOB + 1)
    assert exc.value.code == "TOO_MANY_SLIDES"


# --------------------------------------------------------------------------- #
# plan_batches — size splitting
# --------------------------------------------------------------------------- #
def test_empty_input_plans_nothing():
    assert plan_batches([]) == []


def test_single_file_over_the_hard_cap_is_unbatchable():
    """No split can help a file that doesn't fit in a request on its own."""
    with pytest.raises(InvalidFileError) as exc:
        plan_batches([img("huge.png", MAX_UPLOAD_BYTES + 1)])
    assert exc.value.code == "PAYLOAD_TOO_LARGE"
    assert "huge.png" in exc.value.message


def test_batch_filled_exactly_to_the_target_stays_one_batch():
    half = BATCH_TARGET_BYTES // 2
    batches = plan_batches([img("a", half), img("b", BATCH_TARGET_BYTES - half)])
    assert names(batches) == [["a", "b"]]


def test_one_byte_past_the_target_starts_a_second_batch():
    half = BATCH_TARGET_BYTES // 2
    batches = plan_batches([img("a", half), img("b", BATCH_TARGET_BYTES - half + 1)])
    assert names(batches) == [["a"], ["b"]]


def test_file_between_the_target_and_the_hard_cap_is_still_placed_alone():
    """Over the batch target but under the request cap: it gets its own batch
    rather than being refused."""
    big = (BATCH_TARGET_BYTES + MAX_UPLOAD_BYTES) // 2
    batches = plan_batches([img("small", 10), img("big", big), img("tail", 10)])
    assert names(batches) == [["small"], ["big"], ["tail"]]


# --------------------------------------------------------------------------- #
# plan_batches — page splitting
# --------------------------------------------------------------------------- #
def test_exactly_the_page_limit_is_one_batch():
    batches = plan_batches([img(f"p{i}") for i in range(MAX_PAGES_PER_JOB)])
    assert len(batches) == 1
    assert len(batches[0]) == MAX_PAGES_PER_JOB


def test_one_image_past_the_page_limit_splits_off():
    batches = plan_batches([img(f"p{i}") for i in range(MAX_PAGES_PER_JOB + 1)])
    assert [len(b) for b in batches] == [MAX_PAGES_PER_JOB, 1]
    assert names(batches)[1] == [f"p{MAX_PAGES_PER_JOB}"]


# --------------------------------------------------------------------------- #
# plan_batches — PDFs and ordering
# --------------------------------------------------------------------------- #
def test_each_pdf_gets_its_own_batch():
    batches = plan_batches([pdf("one.pdf"), pdf("two.pdf")])
    assert names(batches) == [["one.pdf"], ["two.pdf"]]


def test_a_pdf_splits_the_images_around_it():
    """The SDK can't count a PDF's pages, so it never rides along with others."""
    batches = plan_batches([img("a"), pdf("doc.pdf"), img("b")])
    assert names(batches) == [["a"], ["doc.pdf"], ["b"]]


def test_order_is_preserved_and_planning_is_deterministic():
    items = [img("a", 10), img("b", 20), pdf("c.pdf", 30), img("d", 40)]
    first = names(plan_batches(items))
    assert first == [["a", "b"], ["c.pdf"], ["d"]]
    assert names(plan_batches(items)) == first  # same input, same plan
