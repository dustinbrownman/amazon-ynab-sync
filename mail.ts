import IMAP from "node-imap";
import * as cheerio from "cheerio";
import quotedPrintable from "quoted-printable";
import { dateFormat, dollarFormat } from "./index.js";
import YNAB, { Order } from "./ynab.js";

const HISTORICAL_SEARCH_NUM_EMAILS = parseInt(
  process.env.HISTORICAL_SEARCH_NUM_EMAILS || "500"
);

interface Email {
  from: string;
  subject: string;
  body: string;
  attributes: IMAP.ImapMessageAttributes;
}

interface EmailHeader {
  from: string;
  subject: string;
  attributes: IMAP.ImapMessageAttributes;
  body?: string;
}

const isAmazonEmail = ({ from }: Email | EmailHeader): boolean =>
  from.includes("auto-confirm@amazon.com");

const scanEmail = (email: Email): Order | undefined => {
  const { subject, body, attributes } = email;

  if (!isAmazonEmail(email)) {
    console.log(
      "Ignoring... not an Amazon order email (subject or body mismatch)"
    );
    return;
  }

  // Mail forwarding sometimes messes with ID/class attributes,
  // so cleaning up the attributes prefixed with "x_"
  const $ = cheerio.load(body.replace(/"x_/g, '"'));

  try {
    // Try to find the total amount - look for "Total" label and get adjacent cell value
    let amount = 0;

    // Method 1: Look for table with "Total" text and extract the dollar amount from the adjacent cell
    $("table").each((_, table) => {
      const $table = $(table);
      const text = $table.text();
      if (text.includes("Total")) {
        // Look for dollar amounts in this table
        const match = text.match(/\$(\d+\.\d{2})/);
        if (match) {
          amount = parseFloat(match[1]);
          return false; // break out of each loop
        }
      }
    });

    // Method 2: Fallback to old selector if Method 1 didn't work
    if (amount === 0) {
      const costText = $('table[id$="costBreakdownRight"] td').text().trim();
      if (costText && costText.startsWith("$")) {
        amount = parseFloat(costText.slice(1));
      }
    }

    if (amount === 0) return;

    const items: string[] = [];

    // Method 1: Look for links containing product names (more reliable for new format)
    $("a").each((_, link) => {
      const $link = $(link);
      const href = $link.attr("href") || "";
      const text = $link.text().trim();

      // If link contains /dp/ or mentions product, and has meaningful text
      if (
        (href.includes("/dp/") || href.includes("asin")) &&
        text.length > 0 &&
        text.length < 200
      ) {
        // Filter out navigation links and common UI text
        const excludePatterns = [
          "View or edit order",
          "Your Orders",
          "Your Account",
          "Buy Again",
          "Track package",
        ];
        if (!excludePatterns.some((pattern) => text.includes(pattern))) {
          // Clean up the title
          let title = text;
          if (title.endsWith("...")) {
            title = title.split(" ").slice(0, -1).join(" ");
            if (title.endsWith(",")) title = title.slice(0, -1);
            title += "..";
          }
          items.push(title);
        }
      }
    });

    // Method 2: Fallback to old selector for item details table
    if (items.length === 0) {
      const itemRows = $('table[id$="itemDetails"] tr').toArray();
      for (const itemRow of itemRows) {
        let title = $(itemRow).find("font").text().trim();
        if (title.endsWith("...")) {
          title = title.split(" ").slice(0, -1).join(" ");
          if (title.endsWith(",")) title = title.slice(0, -1);
          title += "..";
        }
        if (title.length === 0) continue;
        items.push(title);
      }
    }

    if (items.length === 0) return;

    const date = new Date(attributes.date.setHours(0, 0, 0, 0));

    console.info(
      `Found ${dollarFormat(amount)} order on ${dateFormat(date)} of ${
        items.length
      } item(s): ${items.join(", ")}`
    );

    return {
      date,
      amount: -(amount * 1000),
      items,
    };
  } catch (e) {
    console.error(e);
    console.error(`This failed on email with subject: ${subject}`);
  }
};

const readEmail = (
  imapMsg: IMAP.ImapMessage,
  readBody = true
): Promise<Email | EmailHeader> =>
  new Promise((resolve, reject) => {
    let headers: any = null;
    let body: string | null = null;
    let attributes: IMAP.ImapMessageAttributes | null = null;
    imapMsg.once("attributes", function (attrs) {
      attributes = attrs;
    });
    imapMsg.on("body", (stream, info) => {
      let buffer = "";
      let count = 0;
      stream.on("data", function (chunk) {
        count += chunk.length;
        buffer += chunk.toString("utf8");
      });
      stream.once("end", function () {
        switch (info.which) {
          case "HEADER.FIELDS (FROM SUBJECT)":
            headers = IMAP.parseHeader(buffer);
            break;
          case "TEXT":
            body = quotedPrintable.decode(buffer.toString());
            break;
        }
      });
    });
    imapMsg.once("end", function (attrs) {
      if (
        attributes &&
        headers &&
        headers.subject &&
        headers.subject.length > 0 &&
        (!readBody || body)
      ) {
        resolve({
          from: headers.from[0],
          subject: headers.subject[0],
          attributes,
          body: body || "",
        } as Email | EmailHeader);
      } else {
        reject();
      }
    });
  });

const fetchOrderEmails = async (
  seq: any,
  startIndex: number,
  endIndex: number
): Promise<Email[]> =>
  new Promise((resolve, reject) => {
    const fetch = seq.fetch(`${startIndex}:${endIndex}`, {
      bodies: ["HEADER.FIELDS (FROM SUBJECT)", "TEXT"],
      struct: true,
    });
    const emails: Email[] = [];
    fetch.on("message", async (imapMsg: any) => {
      try {
        const email = (await readEmail(imapMsg, true)) as Email;
        emails.push(email);
      } catch (e) {
        console.error(e);
      }
    });
    fetch.once("end", function () {
      resolve(emails);
    });
    fetch.once("error", function (err: any) {
      reject(err);
    });
  });

export const historicalSearch = async (
  imap: IMAP,
  ynab: YNAB,
  box: IMAP.Box,
  orders: Order[]
): Promise<void> =>
  new Promise((resolve) => {
    console.log(
      `Searching back over last ${HISTORICAL_SEARCH_NUM_EMAILS} emails...`
    );

    const endIndex = box.messages.total;
    const startIndex = endIndex - (HISTORICAL_SEARCH_NUM_EMAILS - 1);
    const fetch = imap.seq.fetch(`${startIndex}:${endIndex}`, {
      bodies: ["HEADER.FIELDS (FROM SUBJECT)"],
      struct: true,
    });

    const emailFetches: Promise<void>[] = [];
    const amazonMsgSeqNums: number[] = [];
    let processedEmails = 0;

    fetch.on("message", (imapMsg, seqno) => {
      emailFetches.push(
        new Promise(async (resolve, reject) => {
          try {
            const email = (await readEmail(imapMsg, false)) as EmailHeader;
            if (isAmazonEmail(email)) amazonMsgSeqNums.push(seqno);
            processedEmails++;
            console.log(
              `${processedEmails} emails collected... Limit: ${HISTORICAL_SEARCH_NUM_EMAILS}`
            );
            resolve();
          } catch (e) {
            console.error(e);
            reject();
          }
        })
      );
    });

    fetch.on("error", (err: any) => {
      throw new Error(String(err));
    });

    fetch.once("end", async () => {
      await Promise.allSettled(emailFetches);

      const amazonEmailCount = amazonMsgSeqNums.length;
      console.info(
        `${amazonEmailCount} Amazon order confirmation emails found`
      );

      const emailScans: Promise<void>[] = [];

      amazonMsgSeqNums.forEach((seqno) => {
        emailScans.push(
          new Promise(async (resolve, reject) => {
            try {
              const [email] = await fetchOrderEmails(imap.seq, seqno, seqno);
              const order = await scanEmail(email);
              if (order) orders.push(order);
              resolve();
            } catch (e) {
              console.error(e);
              reject();
            }
          })
        );
      });

      await Promise.allSettled(emailScans);

      console.log("Finished scanning old emails successfully!");

      if (orders.length > 0) {
        orders.sort(function (a, b) {
          return new Date(a.date).getTime() - new Date(b.date).getTime();
        });

        const sinceDate = orders[0].date;
        await ynab.fetchTransactions(sinceDate);
        const matches = ynab.matchTransactions(orders);
        await ynab.updateTransactions(matches);
      }

      resolve();
    });
  });

export const watchInbox = (
  imap: IMAP,
  ynab: YNAB,
  box: IMAP.Box,
  orders: Order[]
): void => {
  imap.on("mail", async (newEmailCount: number) => {
    console.log(`${newEmailCount} new email(s), scanning contents...`);
    const endIndex = box.messages.total;
    const startIndex = endIndex - (newEmailCount - 1);
    try {
      const emails = await fetchOrderEmails(imap.seq, startIndex, endIndex);
      for (const email of emails) {
        const order = scanEmail(email);
        if (order) orders.push(order);
      }
      await ynab.matchAndUpdate(orders);
    } catch (e) {
      console.error(e);
    }
  });
};
