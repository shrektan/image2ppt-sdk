"""Unit tests for upload-size limits and batch planning.

Pure functions only: no client, no files, no network. Sizes are plain integers,
so these run instantly and stay readable.
"""

from __future__ import annotations

import pytest

from image2ppt import (
    BATCH_TARGET_BYTES,
    MAX_FILE_BYTES,
    MAX_PAGES_PER_JOB,
    MAX_UPLOAD_BYTES,
    InvalidFileError,
    TooManySlidesError,
    UploadItem,
    check_file_size,
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
# check_file_size — a property of the file, not of the request
#
# The per-file cap is STRICTER than the request cap (35MB vs 45MB), so a file can
# sit comfortably inside a request and still be rejected by the server every time.
# --------------------------------------------------------------------------- #
def test_a_file_exactly_on_the_per_file_cap_is_fine():
    check_file_size("ok.pdf", MAX_FILE_BYTES)


def test_a_file_one_byte_over_the_per_file_cap_is_refused():
    with pytest.raises(InvalidFileError) as exc:
        check_file_size("big.pdf", MAX_FILE_BYTES + 1)
    assert exc.value.code == "INVALID_FILE"
    assert "big.pdf" in exc.value.message


def test_the_per_file_cap_is_stricter_than_the_request_cap():
    """Guards the reason this check exists: without it, a file between the two
    caps looks submittable to the batch planner and never is."""
    assert MAX_FILE_BYTES < MAX_UPLOAD_BYTES
    between = (MAX_FILE_BYTES + MAX_UPLOAD_BYTES) // 2
    check_submission(between, 1)  # the request cap is happy with it
    with pytest.raises(InvalidFileError):
        check_file_size("between.pdf", between)  # the file cap is not


def test_the_pre_flight_is_never_stricter_than_the_documented_cap():
    """The published limit must be reachable — refusing what the server accepts is
    the same class of bug as letting through what it does not, only with the client
    doing the refusing.

    The batch planner may be conservative (splitting one batch earlier costs
    nothing); this gate may not be. Pinning both directions keeps a future "let's
    leave ourselves some margin" from quietly shrinking the usable limit.
    """
    check_submission(MAX_UPLOAD_BYTES, 1)  # exactly the documented cap: must pass
    assert BATCH_TARGET_BYTES < MAX_UPLOAD_BYTES  # the planner, and only it, is under


# --------------------------------------------------------------------------- #
# check_submission — the pre-flight gate
# --------------------------------------------------------------------------- #
def test_check_accepts_a_submission_at_both_limits():
    check_submission(BATCH_TARGET_BYTES, MAX_PAGES_PER_JOB)  # exactly at the cap


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


def test_single_oversized_file_is_unbatchable():
    """No split can help a file the server rejects on its own. The planner applies
    the per-file cap, so it stops at 35MB rather than waiting for 45MB."""
    with pytest.raises(InvalidFileError) as exc:
        plan_batches([img("huge.png", MAX_FILE_BYTES + 1)])
    assert exc.value.code == "INVALID_FILE"
    assert "huge.png" in exc.value.message


def test_a_file_between_the_two_caps_is_refused_by_the_planner():
    """The regression this guards: it fits the request cap, so the planner used to
    build a batch for it that the server would reject every single time."""
    between = (MAX_FILE_BYTES + BATCH_TARGET_BYTES) // 2
    with pytest.raises(InvalidFileError):
        plan_batches([img("doomed.pdf", between)])


def test_batch_filled_exactly_to_the_target_stays_one_batch():
    half = BATCH_TARGET_BYTES // 2
    batches = plan_batches([img("a", half), img("b", BATCH_TARGET_BYTES - half)])
    assert names(batches) == [["a", "b"]]


def test_one_byte_past_the_target_starts_a_second_batch():
    half = BATCH_TARGET_BYTES // 2
    batches = plan_batches([img("a", half), img("b", BATCH_TARGET_BYTES - half + 1)])
    assert names(batches) == [["a"], ["b"]]


def test_two_max_size_files_get_a_batch_each():
    """The largest legal file is 35MB, so two of them blow the 40MB batch target
    and must be split — neither is refused."""
    batches = plan_batches([img("a", MAX_FILE_BYTES), img("b", MAX_FILE_BYTES)])
    assert names(batches) == [["a"], ["b"]]


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


def test_format_bytes_does_not_round_small_overages_to_zero():
    """一个字节的超出不能被印成 0.0MB。

    否则错误消息会变成「45.0MB 超过 45.0MB（超了 0.0MB）」——自相矛盾，
    读起来像是这道检查本身坏了。真实联调时就是这么显示的。
    """
    from image2ppt._limits import (
        BATCH_TARGET_BYTES,
        check_submission,
        format_bytes,
    )
    from image2ppt.errors import InvalidFileError

    assert format_bytes(1) == "1B"
    assert format_bytes(32 * 1024) == "32.0KB"
    assert format_bytes(5 * 1024 * 1024) == "5.0MB"

    try:
        check_submission(total_bytes=MAX_UPLOAD_BYTES + 1, image_pages=1)
    except InvalidFileError as exc:
        assert "0.0MB too much" not in str(exc)
    else:
        raise AssertionError("超限没有被拦下")


# --------------------------------------------------------------------------- #
# PDFs in the page pre-check
#
# An image is exactly 1 page; a PDF is however many it holds, and the SDK does not
# parse PDFs. Counting each PDF as *at least* 1 is a lower bound, but the lower
# bound is what catches the combinations that can never succeed.
# --------------------------------------------------------------------------- #
def test_a_full_page_of_images_plus_one_pdf_is_already_over():
    """The regression: 50 images passed the check, and the PDF made it 51+."""
    with pytest.raises(TooManySlidesError) as exc:
        check_submission(1, MAX_PAGES_PER_JOB, pdf_files=1)
    assert exc.value.code == "TOO_MANY_SLIDES"
    assert "at least 51" in exc.value.message


def test_pdfs_alone_can_also_blow_the_page_limit():
    with pytest.raises(TooManySlidesError):
        check_submission(1, 0, pdf_files=MAX_PAGES_PER_JOB + 1)


def test_images_plus_pdfs_exactly_on_the_limit_pass():
    check_submission(1, MAX_PAGES_PER_JOB - 1, pdf_files=1)


def test_pdf_count_defaults_to_zero_for_an_all_image_submission():
    check_submission(1, MAX_PAGES_PER_JOB)


def test_the_page_check_is_a_lower_bound_not_the_servers_verdict():
    """One PDF counts as 1 page here even if it holds 500. This test exists to
    make that limitation explicit rather than a surprise: passing locally does
    not promise the server will accept it."""
    check_submission(1, 0, pdf_files=1)  # a 500-page PDF looks fine from here


def test_image_batches_count_pages_exactly_because_pdfs_never_join_them():
    """plan_batches does NOT need the lower-bound treatment: a PDF always takes a
    batch of its own, so a batch being filled holds only images, and an image is
    always exactly 1 page."""
    items = [img(f"p{i}") for i in range(MAX_PAGES_PER_JOB)] + [pdf("doc.pdf")]
    batches = plan_batches(items)
    assert [len(b) for b in batches] == [MAX_PAGES_PER_JOB, 1]
    assert all(not item.is_pdf for item in batches[0])  # no PDF snuck into the image batch
