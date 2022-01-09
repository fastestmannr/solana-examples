use anchor_lang::prelude::*;
use anchor_lang::AccountsClose;
use anchor_lang::solana_program;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{token, associated_token};
use spl_associated_token_account::get_associated_token_address;
use spl_token::state::Multisig;
use std::convert::TryFrom;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

const _ESCROW_SEED: &[u8] = "escrow".as_bytes();

fn _check_tender_args(current_cost: u64, add_cost: u64, current_qty: u64, add_qty: u64) -> ProgramResult {
    if add_cost == 0 || add_qty == 0 {
        return Err(ProgramError::InvalidArgument);
    }

    // In real numbers we want (current_cost + add_cost) / current_cost = (current_qty + add_qty) / current_qty.
    // This is equivalent algebraically to current_qty * (current_cost + add_cost) = current_cost * (current_qty + add_qty)
    // ...current_qty * current_cost + current_qty * add_cost = current_cost * current_qty + current_cost * add_qty
    // ...current_qty * add_cost = current_cost * add_qty
    let lhs = (current_qty as u128).checked_mul(add_cost as u128).ok_or(ProgramError::InvalidArgument)?;
    let rhs = (current_cost as u128).checked_mul(add_qty as u128).ok_or(ProgramError::InvalidArgument)?;
    if lhs != rhs {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(())
}

fn _get_purchase_cost(qty: u64, total_qty: u64, total_cost: u64) -> Result<u64, ProgramError> {
    if  qty == 0 || qty > total_qty {
        return Err(ProgramError::InvalidArgument);
    }

    // cost = (qty / total_qty) * total_cost
    //       = (qty * total_cost) / total_qty
    // to check, make sure total_qty * cost = qty * total_cost
    let cost = (qty as u128).checked_mul(total_cost as u128).and_then(|r| r.checked_div(total_qty as u128)).ok_or(ProgramError::InvalidArgument)?;
    let lhs = (total_qty as u128).checked_mul(cost as u128).ok_or(ProgramError::InvalidArgument)?;
    let rhs = (qty as u128).checked_mul(total_cost as u128).ok_or(ProgramError::InvalidArgument)?;
    if lhs != rhs {
        return Err(ProgramError::InvalidArgument);
    }
    return match u64::try_from(cost) {
        Ok(c) => Ok(c),
        Err(_) => Err(ProgramError::InvalidArgument),
    }
}

#[program]
pub mod escrow {
    use super::*;

    pub fn tender(ctx: Context<Tender>, bump_seed: u8, total_purchase_cost: u64, asset_quantity_for_sale: u64) -> ProgramResult {
        let escrow_account = &mut ctx.accounts.escrow_account;
        let escrow_token_account = &mut ctx.accounts.escrow_token_account;

        _check_tender_args(escrow_account.total_purchase_cost, total_purchase_cost, escrow_token_account.amount, asset_quantity_for_sale)?;

        let transfer_ctx = CpiContext::new(ctx.accounts.token_program.clone(), token::Transfer {
            authority: ctx.accounts.seller.to_account_info(),
            from: ctx.accounts.sell_from_account.to_account_info(),
            to: escrow_token_account.to_account_info(),
        });
        token::transfer(transfer_ctx, asset_quantity_for_sale)?;

        escrow_account.total_purchase_cost += total_purchase_cost;
        escrow_account.bump_seed = bump_seed;
        
        Ok(())
    }

    pub fn tender_from_mint<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, TenderFromMint<'info>>,
        bump_seed: u8, total_purchase_cost: u64, asset_quantity_for_sale: u64
    ) -> ProgramResult {
        let escrow_account = &mut ctx.accounts.escrow_account;
        let escrow_token_account = &mut ctx.accounts.escrow_token_account;

        _check_tender_args(escrow_account.total_purchase_cost, total_purchase_cost, escrow_token_account.amount, asset_quantity_for_sale)?;

        // TODO: switch to anchor CPI once they support multi-sig
        if ctx.accounts.mint_authority.to_account_info().data_len() == Multisig::get_packed_len() {
            let mut signers: std::vec::Vec<AccountInfo> = std::vec::Vec::new();
            let mut signer_keys: std::vec::Vec<& Pubkey> = std::vec::Vec::new();
            for account_info in ctx.remaining_accounts {
                if account_info.is_signer {
                    signers.push(account_info.clone());
                    signer_keys.push(account_info.key);
                }
            }
            let ix = spl_token::instruction::mint_to(
                ctx.accounts.token_program.key,
                ctx.accounts.mint.to_account_info().key,
                ctx.accounts.escrow_token_account.to_account_info().key,
                ctx.accounts.mint_authority.key,
                signer_keys.as_slice(),
                asset_quantity_for_sale,
            )?;
            let mut account_infos = vec!(
                ctx.accounts.escrow_token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.mint_authority.clone(),
                ctx.accounts.token_program.clone(),
            );
            account_infos.append(&mut signers);
            solana_program::program::invoke_signed(
                &ix,
                account_infos.as_slice(),
                &[],
            )?;
        } else {
            let mint_ctx = CpiContext::new(ctx.accounts.token_program.clone(), token::MintTo {
                authority: ctx.accounts.mint_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: escrow_token_account.to_account_info(),
            });
            token::mint_to(mint_ctx, asset_quantity_for_sale)?;
        }

        escrow_account.total_purchase_cost += total_purchase_cost;
        escrow_account.bump_seed = bump_seed;
        
        Ok(())
    }

    pub fn purchase(ctx: Context<Purchase>) -> ProgramResult {
        let quantity_remaining = ctx.accounts.escrow_token_account.amount;
        purchase_partial(ctx, quantity_remaining)?;

        Ok(())
    }

    pub fn purchase_partial(ctx: Context<Purchase>, quantity_to_transfer: u64) -> ProgramResult {
        let escrow_account = &mut ctx.accounts.escrow_account;

        let purchase_cost = _get_purchase_cost(
            quantity_to_transfer,
            ctx.accounts.escrow_token_account.amount,
            escrow_account.total_purchase_cost
        )?;

        // First transfer the payer's payment and reduce the total cost for future
        let transfer_ctx = CpiContext::new(ctx.accounts.token_program.clone(), token::Transfer {
            authority: ctx.accounts.signer.to_account_info(),
            from: ctx.accounts.buy_from_account.to_account_info(),
            to: ctx.accounts.seller_proceeds_account.to_account_info(),
        });
        token::transfer(transfer_ctx, purchase_cost)?;
        escrow_account.total_purchase_cost = escrow_account.total_purchase_cost.checked_sub(purchase_cost).ok_or(ProgramError::InsufficientFunds)?;

        let signer_seeds: &[&[&[u8]]] = &[&[
            _ESCROW_SEED,
            &ctx.accounts.seller_proceeds_account.key().to_bytes(),
            &ctx.accounts.receiver.key().to_bytes(),
            &ctx.accounts.mint.key().to_bytes(),
            &ctx.accounts.purchase_mint.key().to_bytes(),
            &ctx.accounts.rent_payer.key().to_bytes(),
            &[ctx.accounts.escrow_account.bump_seed]
            ]];

        // TODO: support creating this account if it doesn't already exist
        // Second transfer the asset to the receiver
        let transfer_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.clone(), token::Transfer {
            authority: ctx.accounts.escrow_account.to_account_info(),
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.buy_to_account.to_account_info(),
        }, signer_seeds);
        token::transfer(transfer_ctx, quantity_to_transfer)?;

        // Third close the accounts
        ctx.accounts.escrow_token_account.reload()?;
        if ctx.accounts.escrow_token_account.amount == 0 {
            let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.clone(), token::CloseAccount {
                authority: ctx.accounts.escrow_account.to_account_info(),
                account: ctx.accounts.escrow_token_account.to_account_info(),
                destination: ctx.accounts.rent_payer.to_account_info(),
            }, signer_seeds);
            token::close_account(close_ctx)?;

            ctx.accounts.escrow_account.close(ctx.accounts.rent_payer.clone())?;
        }

        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>) -> ProgramResult {
        let signer_seeds: &[&[&[u8]]] = &[&[
            _ESCROW_SEED,
            &ctx.accounts.seller_proceeds_account.key().to_bytes(),
            &ctx.accounts.receiver.key().to_bytes(),
            &ctx.accounts.mint.key().to_bytes(),
            &ctx.accounts.purchase_mint.key().to_bytes(),
            &ctx.accounts.seller.key().to_bytes(),
            &[ctx.accounts.escrow_account.bump_seed]
            ]];

        // Return the funds from the escrow token account to the original seller
        let transfer_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.clone(), token::Transfer {
            authority: ctx.accounts.escrow_account.to_account_info(),
            from: ctx.accounts.escrow_token_account.to_account_info(),
            to: ctx.accounts.sell_from_account.to_account_info(),
        }, signer_seeds);
        token::transfer(transfer_ctx, ctx.accounts.escrow_token_account.amount)?;

        // Close the token account
        let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.clone(), token::CloseAccount {
            authority: ctx.accounts.escrow_account.to_account_info(),
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.seller.to_account_info(),
        }, signer_seeds);
        token::close_account(close_ctx)?;

        Ok(())
    }

    pub fn burn(ctx: Context<Burn>, quantity: u64) -> ProgramResult {
        if quantity == 0 || quantity > ctx.accounts.escrow_token_account.amount {
            return Err(ProgramError::InvalidArgument);
        }
        let signer_seeds: &[&[&[u8]]] = &[&[
            _ESCROW_SEED,
            &ctx.accounts.seller_proceeds_account.key().to_bytes(),
            &ctx.accounts.receiver.key().to_bytes(),
            &ctx.accounts.mint.key().to_bytes(),
            &ctx.accounts.purchase_mint.key().to_bytes(),
            &ctx.accounts.rent_payer.key().to_bytes(),
            &[ctx.accounts.escrow_account.bump_seed]
            ]];

        // Burn the tokens
        let burn_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.clone(), token::Burn {
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.escrow_token_account.to_account_info(),
            authority: ctx.accounts.escrow_account.to_account_info(),
        }, signer_seeds);
        token::burn(burn_ctx, quantity)?;

        ctx.accounts.escrow_token_account.reload()?;
        if ctx.accounts.escrow_token_account.amount == 0 {
            let close_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.clone(), token::CloseAccount {
                authority: ctx.accounts.escrow_account.to_account_info(),
                account: ctx.accounts.escrow_token_account.to_account_info(),
                destination: ctx.accounts.rent_payer.to_account_info(),
            }, signer_seeds);
            token::close_account(close_ctx)?;

            ctx.accounts.escrow_account.close(ctx.accounts.rent_payer.to_account_info())?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(bump_seed: u8)]
pub struct Tender<'info> {
    /// The account in which to store the escrow metadata. This must be a PDA with seeds ["escrow", seller_proceeds_account, receiver, mint, purchase_mint, rent_payer]
    #[account(init_if_needed,
        payer = seller,
        seeds = [_ESCROW_SEED, seller_proceeds_account.key().as_ref(), receiver.key().as_ref(), mint.key().as_ref(), purchase_mint.key().as_ref(), seller.key().as_ref()],
        bump = bump_seed,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    /// The account in which to store the tokens. It should be the associated token account for the escrow_account's public key
    #[account(init_if_needed,
        payer = seller,
        associated_token::mint = mint,
        associated_token::authority = escrow_account,
    )]     
    pub escrow_token_account: Account<'info, token::TokenAccount>,

    /// The seller who is creating this escrow account. The seller must be the signer of this transaction
    #[account(mut)]
    pub seller: Signer<'info>,
    /// The user that will receive the tokens from this escrow account once payment is made
    pub receiver: AccountInfo<'info>,

    /// The mint account for the token in escrow
    pub mint: Box<Account<'info, token::Mint>>,
    /// The mint account for the token used to purchase from this escrow
    pub purchase_mint: Box<Account<'info, token::Mint>>,

    /// The seller's token account into which the proceeds will be transferred
    #[account(constraint=(seller_proceeds_account.mint == purchase_mint.key() && seller_proceeds_account.owner == seller.key()))]
    pub seller_proceeds_account: Box<Account<'info, token::TokenAccount>>,
    /// The seller's token account from which the tokens for sale will be trasnferred to create the escrow
    #[account(mut, constraint=(sell_from_account.mint == mint.key() && sell_from_account.owner == seller.key()))]
    pub sell_from_account: Box<Account<'info, token::TokenAccount>>,

    // Required system-wide accounts
    #[account(address=token::ID)]
    pub token_program: AccountInfo<'info>,
    #[account(address=associated_token::ID)]
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(bump_seed: u8)]
pub struct TenderFromMint<'info> {
    /// The account in which to store the escrow metadata. This must be a PDA with seeds ["escrow", seller_proceeds_account, receiver, mint, purchase_mint, rent_payer]
    #[account(init_if_needed,
        payer = payer,
        seeds = [_ESCROW_SEED, seller_proceeds_account.key().as_ref(), receiver.key().as_ref(), mint.key().as_ref(), purchase_mint.key().as_ref(), payer.key().as_ref()],
        bump = bump_seed,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    /// The account in which to store the tokens. It should be the associated token account for the escrow_account's public key
    #[account(init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = escrow_account,
    )]     
    pub escrow_token_account: Account<'info, token::TokenAccount>,

    /// The mint_authority who is creating this escrow account. Must be the signer of this transaction
    #[account(mut)]
    pub mint_authority: AccountInfo<'info>,
    /// The account that will fund the creation of the escrow and token account
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The user that will receive the tokens from this escrow account once payment is made
    pub receiver: AccountInfo<'info>,

    /// The mint account for the token in escrow
    #[account(mut)]
    pub mint: Box<Account<'info, token::Mint>>,
    /// The mint account for the token used to purchase from this escrow
    pub purchase_mint: Box<Account<'info, token::Mint>>,

    /// The seller's token account into which the proceeds will be transferred
    #[account(constraint=(seller_proceeds_account.mint == purchase_mint.key()))]
    pub seller_proceeds_account: Box<Account<'info, token::TokenAccount>>,

    // Required system-wide accounts
    #[account(address=token::ID)]
    pub token_program: AccountInfo<'info>,
    #[account(address=associated_token::ID)]
    pub associated_token_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Purchase<'info> {
    /// The account that holds the escrow metadata
    #[account(mut,
        seeds = [_ESCROW_SEED, seller_proceeds_account.key().as_ref(), receiver.key().as_ref(), mint.key().as_ref(), purchase_mint.key().as_ref(), rent_payer.key().as_ref()],
        bump = escrow_account.bump_seed,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    /// The account that stores the tokens in escrow. Must be the associated account for the escrow_account
    #[account(mut, address=get_associated_token_address(&escrow_account.key(), &mint.key()))]
    pub escrow_token_account: Account<'info, token::TokenAccount>,

    /// The person who paid to create the account and will receive the rent back
    #[account(mut)]
    pub rent_payer: AccountInfo<'info>,
    /// The user that will receive the tokens from this escrow account once payment is made.
    pub receiver: AccountInfo<'info>,
    /// The person paying to release the tokens from escrow. Must be the signer and own the buy_from_account
    #[account(mut)]
    pub signer: Signer<'info>,

    /// The mint account for the token in escrow
    pub mint: AccountInfo<'info>,
    /// The mint account for the token used to purchase from this escrow
    pub purchase_mint: AccountInfo<'info>,

    /// The seller's token account into which the proceeds will be transferred
    #[account(mut)]
    pub seller_proceeds_account: Box<Account<'info, token::TokenAccount>>,
    /// The signer's token account which will pay the purchase price
    #[account(mut, constraint=(buy_from_account.mint == purchase_mint.key() && buy_from_account.owner == signer.key()))]
    pub buy_from_account: Box<Account<'info, token::TokenAccount>>,
    /// The receiver's token account into which the asset for sale will be deposited
    #[account(mut, constraint=(buy_to_account.mint == mint.key() && buy_to_account.owner == receiver.key()))]
    pub buy_to_account: Box<Account<'info, token::TokenAccount>>,

    // Required system-wide accounts
    #[account(address=token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    /// The account that holds the escrow metadata
    #[account(mut,
        close=seller,
        seeds = [_ESCROW_SEED, seller_proceeds_account.key().as_ref(), receiver.key().as_ref(), mint.key().as_ref(), purchase_mint.key().as_ref(), seller.key().as_ref()],
        bump = escrow_account.bump_seed,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    /// The account that stores the tokens in escrow. Must be the associated account for the escrow_account
    #[account(mut, address=get_associated_token_address(&escrow_account.key(), &mint.key()))]
    pub escrow_token_account: Account<'info, token::TokenAccount>,

    /// The seller who created the escrow account. Must be the signer.
    #[account(mut)]
    pub seller: Signer<'info>,
    /// The user that will receive the tokens from this escrow account once payment is made.
    pub receiver: AccountInfo<'info>,

    /// The mint account for the token in escrow
    pub mint: Box<Account<'info, token::Mint>>,
    /// The mint account for the token used to purchase from this escrow
    pub purchase_mint: Box<Account<'info, token::Mint>>,

    /// The seller's token account into which the proceeds will be transferred
    #[account(mut, constraint=(seller_proceeds_account.owner == seller.key()))]
    pub seller_proceeds_account: Box<Account<'info, token::TokenAccount>>,
    /// The seller's token account to which the escrowed tokens will be returned (note: does not have to be the original account that deposited)
    #[account(mut, constraint=(sell_from_account.mint == mint.key() && sell_from_account.owner == seller.key()))]
    pub sell_from_account: Box<Account<'info, token::TokenAccount>>,

    // Required system-wide accounts
    #[account(address=token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Burn<'info> {
    /// The account that holds the escrow metadata
    #[account(mut,
        seeds = [_ESCROW_SEED, seller_proceeds_account.key().as_ref(), receiver.key().as_ref(), mint.key().as_ref(), purchase_mint.key().as_ref(), rent_payer.key().as_ref()],
        bump = escrow_account.bump_seed,
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
    /// The account that stores the tokens in escrow. Must be the associated account for the escrow_account
    #[account(mut, address=get_associated_token_address(&escrow_account.key(), &mint.key()))]
    pub escrow_token_account: Account<'info, token::TokenAccount>,

    /// The account that paid the rent to create this account. They must be the signer
    #[account(mut)]
    pub rent_payer: Signer<'info>,
    /// The user that will receive the tokens from this escrow account once payment is made.
    pub receiver: AccountInfo<'info>,

    /// The mint account for the token in escrow
    #[account(mut)]
    pub mint: Box<Account<'info, token::Mint>>,
    /// The mint account for the token used to purchase from this escrow
    pub purchase_mint: Box<Account<'info, token::Mint>>,

    /// The seller's token account into which the proceeds will be transferred
    #[account(mut)]
    pub seller_proceeds_account: Box<Account<'info, token::TokenAccount>>,

    // Required system-wide accounts
    #[account(address=token::ID)]
    pub token_program: AccountInfo<'info>,
}

#[account]
#[derive(Default)]
pub struct EscrowAccount {
    pub total_purchase_cost: u64,
    pub bump_seed: u8,
}
