export function reservationMessage(show, request) {
  if (!show) {
    return "상영 일정이 없습니다.";
  }

  if (request.tickets > show.seatsLeft) {
    return "남은 좌석이 부족합니다.";
  }

  const isEligibleForGroupDiscount =
    request.isMember && request.tickets >= 4 && show.isWeekday;

  if (isEligibleForGroupDiscount) {
    return "단체 할인으로 예매되었습니다.";
  }

  return "정상가로 예매되었습니다.";
}
