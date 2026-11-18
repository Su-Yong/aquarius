import assert from "node:assert/strict";
import test from "node:test";
import { discountedTicketPrice as afterDiscount } from "./after/discount.mjs";
import { ticketReceipt as afterReceipt } from "./after/receipt.mjs";
import { reservationMessage as afterReservation } from "./after/reservation.mjs";
import { discountedTicketPrice as beforeDiscount } from "./before/discount.mjs";
import { ticketReceipt as beforeReceipt } from "./before/receipt.mjs";
import { reservationMessage as beforeReservation } from "./before/reservation.mjs";

const weekday = { seatsLeft: 4, isWeekday: true };
const group = { tickets: 4, isMember: true };

const cases = [
  ["상영 일정 없음", null, undefined, "상영 일정이 없습니다."],
  ["좌석 부족", { ...weekday, seatsLeft: 3 }, group, "남은 좌석이 부족합니다."],
  ["평일 회원 4명", weekday, group, "단체 할인으로 예매되었습니다."],
  ["평일 회원 3명", weekday, { ...group, tickets: 3 }, "정상가로 예매되었습니다."],
  ["평일 비회원 4명", weekday, { ...group, isMember: false }, "정상가로 예매되었습니다."],
  ["주말 회원 4명", { ...weekday, isWeekday: false }, group, "정상가로 예매되었습니다."],
];

for (const [name, show, request, expected] of cases) {
  test(name, () => {
    assert.equal(beforeReservation(show, request), expected);
    assert.equal(afterReservation(show, request), expected);
  });
}

const ticket = { price: 15000, isWeekday: true, quantity: 4 };
const member = { isMember: true };
const discounts = [
  ["할인 적용", ticket, member, 12000],
  ["비회원", ticket, { isMember: false }, 15000],
  ["주말", { ...ticket, isWeekday: false }, member, 15000],
  ["3장 구매", { ...ticket, quantity: 3 }, member, 15000],
  ["최소 금액 미달", { ...ticket, price: 9999 }, member, 9999],
];

for (const [name, ticket, customer, expected] of discounts) {
  test(`할인 금액 · ${name}`, () => {
    assert.equal(beforeDiscount(ticket, customer), expected);
    assert.equal(afterDiscount(ticket, customer), expected);
  });
}

test("영화 두 편 영수증", () => {
  const tickets = [
    { title: "별빛 여행", price: 12000, quantity: 2 },
    { title: "바다 탐험", price: 10000, quantity: 1 },
  ];
  const expected = [
    "영화 예매 영수증",
    "별빛 여행: 2장 / 24000원",
    "바다 탐험: 1장 / 10000원",
    "총 수량: 3장",
    "결제 금액: 34000원",
  ].join("\n");
  assert.equal(beforeReceipt(tickets), expected);
  assert.equal(afterReceipt(tickets), expected);
});

test("빈 영수증", () => {
  const expected = "영화 예매 영수증\n총 수량: 0장\n결제 금액: 0원";
  assert.equal(beforeReceipt([]), expected);
  assert.equal(afterReceipt([]), expected);
});
