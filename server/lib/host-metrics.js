import config from 'config';
import { orderBy } from 'lodash';
import moment from 'moment';

import { sequelize } from '../models';

import { getFxRate } from './currency';
import { parseToBoolean } from './utils';

function oppositeTotal(total) {
  return total !== 0 ? -total : total;
}

/**
 * Compute the sum of the given transactions in `currency`
 * @returns number
 */
async function computeTotal(results, currency) {
  let total = 0;

  // For sanity reasons, we handle conversion in case there is any currency mismatch
  for (const result of results) {
    const value = result['_amount'];
    if (value) {
      const fxRate = await getFxRate(result['_currency'], currency);
      total += Math.round(value * fxRate);
    }
  }

  return total;
}

async function convertCurrencyForTimeSeries(results, currency) {
  const fxRates = {}; // FX rates are likely to be the same for all results, better cache them
  for (const result of results) {
    const value = result['_amount'];
    result['currency'] = currency;

    if (value) {
      const resultCurrency = result['_currency'];
      fxRates[resultCurrency] = fxRates[resultCurrency] || {};
      if (!fxRates[resultCurrency][currency]) {
        fxRates[resultCurrency][currency] = await getFxRate(resultCurrency, currency);
      }

      result['amount'] = Math.round(value * fxRates[resultCurrency][currency]);
      result['currency'] = currency;
    } else {
      result['amount'] = 0;
    }
  }

  return results;
}

function computeDates(startDate, endDate) {
  startDate = startDate ? moment(startDate) : moment().utc().startOf('month');
  endDate = endDate ? moment(endDate) : moment(startDate).utc().endOf('month');

  return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

const getGroupTimeUnitFragments = (groupTimeUnit, table) => {
  if (!groupTimeUnit) {
    return { select: '', groupBy: '', orderBy: '' };
  } else {
    return {
      select: `, DATE_TRUNC('${groupTimeUnit}', ${table}."createdAt") AS "date"`,
      groupBy: `, DATE_TRUNC('${groupTimeUnit}', ${table}."createdAt")`,
      orderBy: ` ORDER BY DATE_TRUNC('${groupTimeUnit}', ${table}."createdAt") ASC`,
    };
  }
};

export async function getPlatformTips(host, { startDate, endDate, groupTimeUnit } = {}) {
  const timeUnitFragments = getGroupTimeUnitFragments(groupTimeUnit, 't1');
  const results = await sequelize.query(
    `SELECT
  SUM(
    CASE
      WHEN t2."data"->>'hostToPlatformFxRate' IS NOT NULL THEN
        t2."amountInHostCurrency"::numeric / (t2."data"->>'hostToPlatformFxRate')::numeric
      ELSE
        t2."amountInHostCurrency"
    END
  ) as "_amount",
  (
    CASE
      WHEN t2."data"->>'hostToPlatformFxRate' IS NOT NULL THEN
        h."currency"
      ELSE
        t2."hostCurrency"
    END
   ) as "_currency"${timeUnitFragments.select}
FROM "Transactions" as t1
INNER JOIN "Transactions" as t2
ON t1."TransactionGroup" = t2."TransactionGroup"
INNER JOIN "Collectives" as h
ON t1."HostCollectiveId" = h."id"
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND (t1."kind" IS NULL OR t1."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS'))
AND t2."kind" = 'PLATFORM_TIP'
AND t2."type" = 'CREDIT'
AND t1."deletedAt" IS NULL
AND t2."deletedAt" IS NULL
AND t2."RefundTransactionId" IS NULL
GROUP BY "_currency"${timeUnitFragments.groupBy} ${timeUnitFragments.orderBy}`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  if (groupTimeUnit) {
    return convertCurrencyForTimeSeries(results, host.currency);
  } else {
    return computeTotal(results, host.currency);
  }
}

// NOTE: we're not looking at the settlementStatus and just SUM all debts of the month
export async function getPendingPlatformTips(host, { startDate, endDate } = {}) {
  const results = await sequelize.query(
    `SELECT SUM(t."amountInHostCurrency") AS "_amount", t."hostCurrency" as "_currency"
FROM "Transactions" t
INNER JOIN "TransactionSettlements" ts
  ON t."TransactionGroup" = ts."TransactionGroup"
  AND t."kind" = ts."kind"
WHERE t."HostCollectiveId" = :HostCollectiveId
AND t."isDebt" IS TRUE
AND t."kind" = 'PLATFORM_TIP_DEBT'
AND t."deletedAt" IS NULL
AND ts."deletedAt" IS NULL
AND ts."status" IN ('OWED', 'INVOICED')
AND t."createdAt" >= :startDate
AND t."createdAt" <= :endDate
GROUP BY "hostCurrency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return computeTotal(results, host.currency);
}

export async function getHostFees(host, { startDate, endDate } = {}) {
  let newResults;
  if (parseToBoolean(config.ledger.separateHostFees) === true) {
    newResults = await sequelize.query(
      `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."CollectiveId" = :CollectiveId
AND t1."kind" = 'HOST_FEE'
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
      {
        replacements: { CollectiveId: host.id, ...computeDates(startDate, endDate) },
        type: sequelize.QueryTypes.SELECT,
      },
    );
  }

  // TODO(Ledger): We should only run the query below if startDate < newHostFeeDeployDate
  const legacyResults = await sequelize.query(
    `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND NOT (t1."type" = 'DEBIT' AND t1."kind" = 'ADDED_FUNDS')
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let total = await computeTotal(legacyResults, host.currency);

  // amount/hostFeeInHostCurrency is expressed as a negative number
  total = oppositeTotal(total);

  if (newResults?.length) {
    total += await computeTotal(newResults, host.currency);
  }

  return total;
}

export async function getHostFeesTimeSeries(host, { startDate, endDate, timeUnit } = {}) {
  const newResults = await sequelize.query(
    `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency", DATE_TRUNC('${timeUnit}', t1."createdAt") as "date"
FROM "Transactions" as t1
WHERE t1."CollectiveId" = :CollectiveId
AND t1."kind" = 'HOST_FEE'
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency", DATE_TRUNC('${timeUnit}', t1."createdAt")
ORDER BY DATE_TRUNC('${timeUnit}', t1."createdAt")`,
    {
      replacements: { CollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let legacyResults = [];
  const newHostFeeIntroductionDate = new Date('2021-01-01T00:00:00.000Z');
  if (startDate < newHostFeeIntroductionDate) {
    legacyResults = await sequelize.query(
      `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency", DATE_TRUNC('${timeUnit}', t1."createdAt") as "date"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND NOT (t1."type" = 'DEBIT' AND t1."kind" = 'ADDED_FUNDS')
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency", DATE_TRUNC('${timeUnit}', t1."createdAt")
ORDER BY DATE_TRUNC('${timeUnit}', t1."createdAt")`,
      {
        replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
        type: sequelize.QueryTypes.SELECT,
      },
    );
  }

  const newTimeSeries = await convertCurrencyForTimeSeries(newResults, host.currency);
  const legacyTimeSeries = await convertCurrencyForTimeSeries(legacyResults, host.currency);
  const mergedTimeSeries = [...newTimeSeries.map(point => ({ ...point, amount: Math.abs(point.amount) }))];

  // Merge legacy time series with new time series
  legacyTimeSeries.forEach(point => {
    const existingDataPoint = mergedTimeSeries.find(({ date }) => point.date === date);
    if (existingDataPoint) {
      existingDataPoint.amount += Math.abs(point.amount);
    } else {
      mergedTimeSeries.push({ ...point, amount: Math.abs(point.amount) });
    }
  });

  return orderBy(mergedTimeSeries, 'date');
}

export async function getHostFeeShare(host, { startDate, endDate } = {}) {
  if (parseToBoolean(config.ledger.separateHostFees) === true) {
    const results = await sequelize.query(
      `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."CollectiveId" = :CollectiveId
AND t1."type" = 'DEBIT'
AND t1."kind" = 'HOST_FEE_SHARE'
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
      {
        replacements: { CollectiveId: host.id, ...computeDates(startDate, endDate) },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    let total = await computeTotal(results, host.currency);

    // we're looking at the DEBIT, so it's a negative number
    total = oppositeTotal(total);

    return total;
  }

  const hostFees = await getHostFees(host, { startDate, endDate });

  const plan = await host.getPlan();
  const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

  return Math.round((hostFees * hostFeeSharePercent) / 100);
}

export async function getHostFeeShareTimeSeries(host, { startDate, endDate, timeUnit } = {}) {
  const results = await sequelize.query(
    `SELECT
      SUM(t1."amountInHostCurrency") as "_amount",
      t1."hostCurrency" as "_currency",
      DATE_TRUNC('${timeUnit}', t1."createdAt") as "date",
      COALESCE(ts."status", 'OWED') as "settlementStatus"
    FROM "Transactions" as t1
    LEFT JOIN "TransactionSettlements" ts
      ON t1."TransactionGroup" = ts."TransactionGroup"
      AND ts.kind = 'HOST_FEE_SHARE_DEBT'
      AND ts."deletedAt" IS NULL
    WHERE t1."CollectiveId" = :CollectiveId
    AND t1."type" = 'DEBIT'
    AND t1."kind" = 'HOST_FEE_SHARE'
    AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
    AND t1."deletedAt" IS NULL
    GROUP BY t1."hostCurrency", DATE_TRUNC('${timeUnit}', t1."createdAt"), ts."status"
    ORDER BY DATE_TRUNC('${timeUnit}', t1."createdAt"), ts."status"`,
    {
      replacements: { CollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  const preparedTimeSeries = await convertCurrencyForTimeSeries(results, host.currency);
  return preparedTimeSeries.map(point => ({ ...point, amount: Math.abs(point.amount) }));
}

export async function getPendingHostFeeShare(host, { startDate, endDate } = {}) {
  if (parseToBoolean(config.ledger.separateHostFees) === true) {
    const results = await sequelize.query(
      `SELECT SUM(t."amountInHostCurrency") AS "_amount", t."hostCurrency" as "_currency"
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        WHERE t."CollectiveId" = :CollectiveId
          AND t."type" = 'CREDIT'
          AND t."kind" = 'HOST_FEE_SHARE_DEBT'
          AND t."deletedAt" IS NULL
          AND ts."deletedAt" IS NULL
          AND ts."status" IN ('OWED', 'INVOICED')
          AND t."createdAt" >= :startDate
          AND t."createdAt" <= :endDate
        GROUP BY "hostCurrency"`,
      {
        replacements: { CollectiveId: host.id, ...computeDates(startDate, endDate) },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    return computeTotal(results, host.currency);
  }

  const results = await sequelize.query(
    `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
LEFT JOIN "PaymentMethods" pm ON
  t1."PaymentMethodId" = pm.id
LEFT JOIN "PaymentMethods" spm ON
  spm.id = pm."SourcePaymentMethodId"
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
AND (
  pm."service" != 'stripe'
  OR pm.service IS NULL
)
AND (
  spm.service IS NULL
  OR spm.service != 'stripe'
)
GROUP BY t1."hostCurrency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let total = await computeTotal(results, host.currency);

  // amount/hostFeeInHostCurrency is expressed as a negative number
  total = oppositeTotal(total);

  const plan = await host.getPlan();
  const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

  return Math.round((total * hostFeeSharePercent) / 100);
}
