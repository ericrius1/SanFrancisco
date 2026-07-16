import { parseReadLink } from "../ui/deepLinks";

/**
 * Capture the entry route once. The reader removes `?read=` when it closes, but
 * boot must still remember that this page load began as a reading visit so it
 * never auto-enters the world underneath the modal.
 */
const parsedReadLink = parseReadLink(location.search);

export const initialReadLink = parsedReadLink?.id === "bts" ? parsedReadLink : null;
export const beganAsReadingVisit = initialReadLink !== null;
