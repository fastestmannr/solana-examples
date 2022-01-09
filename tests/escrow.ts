import { strict as assert } from 'assert';
import * as anchor from '@project-serum/anchor';
import * as splToken from '@solana/spl-token';

let program = anchor.workspace.Escrow;

const logInfo = false ? console.log : Function.prototype;

const logAccounts = (description: string, accounts: Object) => {
  logInfo(description, 'accounts')
  let keys = Object.keys(accounts);
  keys.forEach((key, _index) => {
    logInfo(`${key}:`, accounts[key].toBase58());
  });
}

type BasicAccounts = {
  seller: anchor.web3.Keypair,
  buyer: anchor.web3.Keypair,
  mint: splToken.Token,
  purchaseMint: splToken.Token,
  sellFromAccount: splToken.AccountInfo,
  sellerProceedsAccount: splToken.AccountInfo,
  buyFromAccount: splToken.AccountInfo,
  buyToAccount: splToken.AccountInfo,
  escrowAccount: anchor.web3.PublicKey,
  escrowTokenAccount: anchor.web3.PublicKey,
  bumpSeed: number,
}

type MainBalances = {
  sellerSaleToken: splToken.u64,
  sellerPurchaseToken: splToken.u64,
  buyerSaleToken: splToken.u64,
  buyerPurchaseToken: splToken.u64,
}

const getBasicAccounts = async (provider: anchor.Provider, payer?: anchor.web3.PublicKey) => {
  const connection = provider.connection;

  // wallets
  const seller = anchor.web3.Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(seller.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));

  const buyer = anchor.web3.Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(buyer.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));

  // mints
  const tokenDecimals = 0;
  const mint = await splToken.Token.createMint(connection, provider.wallet.payer, provider.wallet.publicKey, null, tokenDecimals, splToken.TOKEN_PROGRAM_ID);
  const purchaseMint = await splToken.Token.createMint(connection, provider.wallet.payer, provider.wallet.publicKey, null, tokenDecimals, splToken.TOKEN_PROGRAM_ID);

  // token accounts
  const sellFromAccount = await mint.getOrCreateAssociatedAccountInfo(seller.publicKey);
  const buyToAccount = await mint.getOrCreateAssociatedAccountInfo(buyer.publicKey);
  const sellerProceedsAccount = await purchaseMint.getOrCreateAssociatedAccountInfo(seller.publicKey);
  const buyFromAccount = await purchaseMint.getOrCreateAssociatedAccountInfo(buyer.publicKey);

  // mints
  await mint.mintTo(sellFromAccount.address, provider.wallet.publicKey, [], 100);
  await purchaseMint.mintTo(buyFromAccount.address, provider.wallet.publicKey, [], 200);

  // program-related accounts
  if (!payer) {
    payer = seller.publicKey;
  }
  const [ escrowAccount, bumpSeed ] = await anchor.web3.PublicKey.findProgramAddress(
    [
      Buffer.from("escrow"),
      sellerProceedsAccount.address.toBuffer(),
      buyer.publicKey.toBuffer(),
      mint.publicKey.toBuffer(),
      purchaseMint.publicKey.toBuffer(),
      payer.toBuffer(),
    ],
    program.programId,
  );
  const escrowTokenAccount = await splToken.Token.getAssociatedTokenAddress(splToken.ASSOCIATED_TOKEN_PROGRAM_ID, splToken.TOKEN_PROGRAM_ID, mint.publicKey, escrowAccount, true);

  return {
    seller: seller,
    buyer: buyer,
    mint: mint,
    purchaseMint: purchaseMint,
    sellFromAccount: sellFromAccount,
    sellerProceedsAccount: sellerProceedsAccount,
    buyFromAccount: buyFromAccount,
    buyToAccount: buyToAccount,
    escrowAccount: escrowAccount,
    escrowTokenAccount: escrowTokenAccount,
    bumpSeed: bumpSeed,
  };
}

const getMainBalances = async (accounts: BasicAccounts) => {
  return {
    sellerSaleToken: (await accounts.mint.getAccountInfo(accounts.sellFromAccount.address)).amount,
    sellerPurchaseToken: (await accounts.purchaseMint.getAccountInfo(accounts.sellerProceedsAccount.address)).amount,
    buyerSaleToken: (await accounts.mint.getAccountInfo(accounts.buyToAccount.address)).amount,
    buyerPurchaseToken: (await accounts.purchaseMint.getAccountInfo(accounts.buyFromAccount.address)).amount,
  };
}

const logMainBalances = (header: string, balances: MainBalances) => {
  logInfo(header);
  logInfo('Seller token balance:', balances.sellerSaleToken.toNumber());
  logInfo('Seller purchase balance:', balances.sellerPurchaseToken.toNumber());
  logInfo('Buyer token balance:', balances.buyerSaleToken.toNumber());
  logInfo('Buyer purchase balance:', balances.buyerPurchaseToken.toNumber());
}

const doDefaultInit = async (basicAccounts: BasicAccounts, totalPurchaseCost: number, assetQty: number) => {
    // Create the new account and tender it with the program.
    const initAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      seller: basicAccounts.seller.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      sellFromAccount: basicAccounts.sellFromAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
      associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
    logAccounts('tender', initAccountsBlock);
    logInfo('bumpSeed:', basicAccounts.bumpSeed);
    logInfo();

    await program.rpc.tender(new anchor.BN(basicAccounts.bumpSeed), new anchor.BN(totalPurchaseCost), new anchor.BN(assetQty), {
      accounts: initAccountsBlock,
      signers: [basicAccounts.seller],
    });
}

const doDefaultPurchase = async (basicAccounts: BasicAccounts) => {
  const purchaseAccountsBlock = {
    escrowAccount: basicAccounts.escrowAccount,
    escrowTokenAccount: basicAccounts.escrowTokenAccount,
    rentPayer: basicAccounts.seller.publicKey,
    receiver: basicAccounts.buyer.publicKey,
    signer: basicAccounts.buyer.publicKey,
    mint: basicAccounts.mint.publicKey,
    purchaseMint: basicAccounts.purchaseMint.publicKey,
    sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
    buyFromAccount: basicAccounts.buyFromAccount.address,
    buyToAccount: basicAccounts.buyToAccount.address,
    tokenProgram: splToken.TOKEN_PROGRAM_ID,
  };
  logAccounts('purchase', purchaseAccountsBlock);

  await program.rpc.purchase({
    accounts: purchaseAccountsBlock,
    signers: [basicAccounts.buyer],
  });
}

describe('escrow', () => {

  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  it("Tenders an escrow account", async () => {
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    const startBalances = await getMainBalances(basicAccounts);
    logMainBalances('Prelim state', startBalances);
    logInfo();
  
    // Create the new account and tender it with the program.
    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);

    // check state was tendered correctly
    const accountPostInit = await program.account.escrowAccount.fetch(basicAccounts.escrowAccount);
    const createdBalances = await getMainBalances(basicAccounts);
    const escrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', escrowPostInitBalance.toNumber());
    logInfo();

    assert.ok(accountPostInit.totalPurchaseCost.eq(new anchor.BN(totalPurchaseCost)));
    assert.ok(escrowPostInitBalance.eq(new anchor.BN(assetQty)));
    assert.ok(startBalances.sellerSaleToken.subn(assetQty).eq(createdBalances.sellerSaleToken));
    assert.ok(program.programId.toBase58() === (await connection.getAccountInfo(basicAccounts.escrowAccount)).owner.toBase58());
    assert.ok(accountPostInit.bumpSeed === basicAccounts.bumpSeed);
  });

  it("Tenders and transfers an escrow account", async () => {
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);
    const createdBalances = await getMainBalances(basicAccounts);
    const EscrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', EscrowPostInitBalance.toNumber());
    logInfo();

    // purchase it
    await doDefaultPurchase(basicAccounts);

    const purchasedBalances = await getMainBalances(basicAccounts);
    logMainBalances('Post purchase', purchasedBalances);
    logInfo();

    // Check state post-purchase is accurate
    assert.ok(createdBalances.sellerPurchaseToken.addn(totalPurchaseCost).eq(purchasedBalances.sellerPurchaseToken));
    assert.ok(createdBalances.buyerSaleToken.addn(assetQty).eq(purchasedBalances.buyerSaleToken));
    assert.ok(createdBalances.buyerPurchaseToken.subn(totalPurchaseCost).eq(purchasedBalances.buyerPurchaseToken));

    // Account should be closed
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) === null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) === null);
  });

  it("Tenders and cancels an escrow account", async () => {
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    const startBalances = await getMainBalances(basicAccounts);
    logMainBalances('Prelim state', startBalances);
    logInfo();

    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);
    const createdBalances = await getMainBalances(basicAccounts);
    const EscrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', EscrowPostInitBalance.toNumber());
    logInfo();

    // cancel it
    const cancelAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      seller: basicAccounts.seller.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      mint: basicAccounts.mint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellFromAccount: basicAccounts.sellFromAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
    };
    logAccounts('cancel', cancelAccountsBlock);

    logInfo('Starting cancel');
    await program.rpc.cancel({
      accounts: cancelAccountsBlock,
      signers: [basicAccounts.seller],
    });
    logInfo('Canceled');

    // Check state post-cancel is accurate
    const canceledBalances = await getMainBalances(basicAccounts);
    logMainBalances('Post cancel', canceledBalances);
    assert.ok(startBalances.sellerPurchaseToken.eq(canceledBalances.sellerPurchaseToken));
    assert.ok(startBalances.buyerSaleToken.eq(canceledBalances.buyerSaleToken));
    assert.ok(startBalances.buyerPurchaseToken.eq(canceledBalances.buyerPurchaseToken));

    // Account should be closed
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) === null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) === null);
  });

  it("Purchases on behalf of another user", async () => {
    // tender
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    // set up the payer
    const payer = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
    const buyFromAccount = await basicAccounts.purchaseMint.getOrCreateAssociatedAccountInfo(payer.publicKey);
    await basicAccounts.purchaseMint.mintTo(buyFromAccount.address, provider.wallet.publicKey, [], 200);

    // init escrow
    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);
    const createdBalances = await getMainBalances(basicAccounts);
    const EscrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    const payerPurchaseTokenCreatedBalance = (await basicAccounts.purchaseMint.getAccountInfo(buyFromAccount.address)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', EscrowPostInitBalance.toNumber());
    logInfo('Payer purchase token balance:', payerPurchaseTokenCreatedBalance.toNumber());
    logInfo();

    // purchase on behalf
    const purchaseAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      rentPayer: basicAccounts.seller.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      signer: payer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      buyFromAccount: buyFromAccount.address,
      buyToAccount: basicAccounts.buyToAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
    };
    logAccounts('purchase', purchaseAccountsBlock);

    await program.rpc.purchase({
      accounts: purchaseAccountsBlock,
      signers: [payer],
    });

    const purchasedBalances = await getMainBalances(basicAccounts);
    const payerPurchaseTokenPurchasedBalance = (await basicAccounts.purchaseMint.getAccountInfo(buyFromAccount.address)).amount;
    logMainBalances('Post purchase', purchasedBalances);
    logInfo('Payer purchase token balance:', payerPurchaseTokenPurchasedBalance.toNumber());
    logInfo();

    // Check state post-purchase is accurate
    assert.ok(createdBalances.sellerPurchaseToken.addn(totalPurchaseCost).eq(purchasedBalances.sellerPurchaseToken));
    assert.ok(createdBalances.buyerSaleToken.addn(assetQty).eq(purchasedBalances.buyerSaleToken));
    assert.ok(payerPurchaseTokenCreatedBalance.subn(totalPurchaseCost).eq(payerPurchaseTokenPurchasedBalance));

    // Account should be closed
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) === null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) === null);
  });

  it("Rejects purchases to the wrong account", async () => {
    // tender
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    // set up the payer
    const payer = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL));
    const buyFromAccount = await basicAccounts.purchaseMint.getOrCreateAssociatedAccountInfo(payer.publicKey);
    await basicAccounts.purchaseMint.mintTo(buyFromAccount.address, provider.wallet.publicKey, [], 200);
    const buyToAccount = await basicAccounts.mint.getOrCreateAssociatedAccountInfo(payer.publicKey);

    // init escrow
    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);

    // purchase to wrong account
    const purchaseAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      rentPayer: basicAccounts.seller.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      signer: payer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      buyFromAccount: buyFromAccount.address,
      buyToAccount: buyToAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
    };
    logAccounts('purchase', purchaseAccountsBlock);

    try {
      await program.rpc.purchase({
        accounts: purchaseAccountsBlock,
        signers: [payer],
      });
    } catch (e) {
      assert.ok(e instanceof anchor.ProgramError);
    }

    // make sure the escrow balance is unchanged, and thus that both accounts are still open
    const resultingAccount = await program.account.escrowAccount.fetch(basicAccounts.escrowAccount);
    const resultingBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    assert.ok(resultingBalance.eq(new anchor.BN(assetQty)));
    assert.ok(resultingAccount.totalPurchaseCost.eq(new anchor.BN(totalPurchaseCost)));
    assert.ok(resultingAccount.bumpSeed === basicAccounts.bumpSeed);
    assert.ok(program.programId.toBase58() === (await connection.getAccountInfo(basicAccounts.escrowAccount)).owner.toBase58());
  });

  it("Tenders from mint and transfers an escrow account", async () => {
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    // Test cutom init
    const initAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      mintAuthority: provider.wallet.publicKey,
      payer: basicAccounts.seller.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
      associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
    logAccounts('tender from mint', initAccountsBlock);
    logInfo('bumpSeed:', basicAccounts.bumpSeed);
    logInfo();

    await program.rpc.tenderFromMint(new anchor.BN(basicAccounts.bumpSeed), new anchor.BN(totalPurchaseCost), new anchor.BN(assetQty), {
      accounts: initAccountsBlock,
      signers: [basicAccounts.seller],
    });
    const createdBalances = await getMainBalances(basicAccounts);
    const EscrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', EscrowPostInitBalance.toNumber());
    logInfo();

    // purchase it
    await doDefaultPurchase(basicAccounts);

    const purchasedBalances = await getMainBalances(basicAccounts);
    logMainBalances('Post purchase', purchasedBalances);
    logInfo();

    // Check state post-purchase is accurate
    assert.ok(createdBalances.sellerPurchaseToken.addn(totalPurchaseCost).eq(purchasedBalances.sellerPurchaseToken));
    assert.ok(createdBalances.buyerSaleToken.addn(assetQty).eq(purchasedBalances.buyerSaleToken));
    assert.ok(createdBalances.buyerPurchaseToken.subn(totalPurchaseCost).eq(purchasedBalances.buyerPurchaseToken));

    // Account should be closed
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) === null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) === null);
  });

  it("Purchases fractional", async () => {
    // tender
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const purchasePricePerUnit = 20;
    const assetQty = 10;
    const initialPurchase = 1;

    // init escrow
    await doDefaultInit(basicAccounts, purchasePricePerUnit * assetQty, assetQty);
    const createdBalances = await getMainBalances(basicAccounts);
    const escrowCreatedBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', escrowCreatedBalance.toNumber());
    logInfo();

    // purchase to other
    const purchaseAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      rentPayer: basicAccounts.seller.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      signer: basicAccounts.buyer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      buyFromAccount: basicAccounts.buyFromAccount.address,
      buyToAccount: basicAccounts.buyToAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
      };
    logAccounts('purchase', purchaseAccountsBlock);

    await program.rpc.purchasePartial(new anchor.BN(initialPurchase), {
      accounts: purchaseAccountsBlock,
      signers: [basicAccounts.buyer],
    });

    const purchasedBalances = await getMainBalances(basicAccounts);
    const escrowPurchasedBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post purchase', purchasedBalances);
    logInfo('Escrow token balance:', escrowPurchasedBalance.toNumber());
    logInfo();

    // Check state post-purchase is accurate
    assert.ok(createdBalances.sellerPurchaseToken.addn(purchasePricePerUnit * initialPurchase).eq(purchasedBalances.sellerPurchaseToken));
    assert.ok(createdBalances.buyerSaleToken.addn(initialPurchase).eq(purchasedBalances.buyerSaleToken));
    assert.ok(escrowCreatedBalance.subn(initialPurchase).eq(escrowPurchasedBalance));
    assert.ok(createdBalances.buyerPurchaseToken.subn(purchasePricePerUnit * initialPurchase).eq(purchasedBalances.buyerPurchaseToken));

    // Account should still be open
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) !== null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) !== null);

    // purchase remainder
    let remaining = assetQty - initialPurchase;
    logInfo('Trying to purchase', remaining)
    await program.rpc.purchasePartial(new anchor.BN(remaining), {
      accounts: purchaseAccountsBlock,
      signers: [basicAccounts.buyer],
    });

    const finalBalances = await getMainBalances(basicAccounts);
    logMainBalances('Post purchase #2', finalBalances);
    logInfo();

    // Check state post-purchase is accurate
    let expectedTotal = purchasePricePerUnit * assetQty;
    logInfo('Expected total purchase price', expectedTotal);
    assert.ok(createdBalances.sellerPurchaseToken.addn(expectedTotal).eq(finalBalances.sellerPurchaseToken));
    assert.ok(createdBalances.buyerPurchaseToken.subn(expectedTotal).eq(finalBalances.buyerPurchaseToken));
    assert.ok(finalBalances.buyerSaleToken.eq(new anchor.BN(assetQty)));

    // Account should be closed
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) === null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) === null);
  });

  it("Tenders and burns an escrow account", async () => {
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider, provider.wallet.publicKey);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    const startBalances = await getMainBalances(basicAccounts);
    logMainBalances('Prelim state', startBalances);
    logInfo();

    // Init from mint
    const initAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      mintAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
      associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
    logAccounts('tender from mint', initAccountsBlock);
    logInfo('bumpSeed:', basicAccounts.bumpSeed);
    logInfo();

    await program.rpc.tenderFromMint(new anchor.BN(basicAccounts.bumpSeed), new anchor.BN(totalPurchaseCost), new anchor.BN(assetQty), {
      accounts: initAccountsBlock,
    });

    const createdBalances = await getMainBalances(basicAccounts);
    const EscrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', EscrowPostInitBalance.toNumber());
    logInfo();

    // burn it
    const burnAccountsBlock = {
      escrowAccount: basicAccounts.escrowAccount,
      escrowTokenAccount: basicAccounts.escrowTokenAccount,
      rentPayer: provider.wallet.publicKey,
      receiver: basicAccounts.buyer.publicKey,
      mint: basicAccounts.mint.publicKey,
      purchaseMint: basicAccounts.purchaseMint.publicKey,
      sellerProceedsAccount: basicAccounts.sellerProceedsAccount.address,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
    };
    logAccounts('burn', burnAccountsBlock);

    logInfo('Starting burn');
    logInfo('Provider wallet', provider.wallet.publicKey.toBase58());
    await program.rpc.burn(new anchor.BN(assetQty), {
      accounts: burnAccountsBlock,
    });
    logInfo('Burned');

    // Check state post-cancel is accurate
    const canceledBalances = await getMainBalances(basicAccounts);
    logMainBalances('Post burn', canceledBalances);
    assert.ok(startBalances.sellerPurchaseToken.eq(canceledBalances.sellerPurchaseToken));
    assert.ok(startBalances.buyerSaleToken.eq(canceledBalances.buyerSaleToken));
    assert.ok(startBalances.buyerPurchaseToken.eq(canceledBalances.buyerPurchaseToken));

    // Account should be closed
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowAccount) === null);
    assert.ok(await connection.getAccountInfo(basicAccounts.escrowTokenAccount) === null);
  });

  it("Tenders an escrow account twice", async () => {
    const basicAccounts: BasicAccounts = await getBasicAccounts(provider);
    const totalPurchaseCost = 200;
    const assetQty = 10;

    const startBalances = await getMainBalances(basicAccounts);
    logMainBalances('Prelim state', startBalances);
    logInfo();
  
    // Create the new account and tender it with the program, twice!
    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);
    await doDefaultInit(basicAccounts, totalPurchaseCost, assetQty);

    // check state was tendered correctly
    const accountPostInit = await program.account.escrowAccount.fetch(basicAccounts.escrowAccount);
    const createdBalances = await getMainBalances(basicAccounts);
    const escrowPostInitBalance = (await basicAccounts.mint.getAccountInfo(basicAccounts.escrowTokenAccount)).amount;
    logMainBalances('Post init', createdBalances);
    logInfo('Escrow token balance:', escrowPostInitBalance.toNumber());
    logInfo();

    assert.ok(accountPostInit.totalPurchaseCost.eq(new anchor.BN(totalPurchaseCost * 2)));
    assert.ok(escrowPostInitBalance.eq(new anchor.BN(assetQty * 2)));
    assert.ok(startBalances.sellerSaleToken.subn(assetQty * 2).eq(createdBalances.sellerSaleToken));
    assert.ok(program.programId.toBase58() === (await connection.getAccountInfo(basicAccounts.escrowAccount)).owner.toBase58());
    assert.ok(accountPostInit.bumpSeed === basicAccounts.bumpSeed);
  });

});
