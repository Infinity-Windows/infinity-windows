import {useState} from "react";
import {useMutation} from "@tanstack/react-query";
import {formatApiError} from "../../lib/errors";
import {formatCompensation, localDayOf, parseRateDollars, rateInEffect, setCompensation, type PayBasis, type PayRate} from "../../lib/payRates";
import "./compensation.css";

export function CompensationPanel({profileId, name, rates, month, canSet, onSaved}: {
  profileId:string; name:string; rates:PayRate[]; month:string; canSet:boolean; onSaved:()=>void;
}) {
  const today=localDayOf(new Date().toISOString());
  const current=rateInEffect(rates,today);
  const selected=rateInEffect(rates,`${month}-01`);
  const [open,setOpen]=useState(false);
  const [basis,setBasis]=useState<PayBasis>("hourly");
  const [amount,setAmount]=useState("");
  const [from,setFrom]=useState(today);
  const monthlyBoundary=basis==="salary_monthly"||current?.payBasis==="salary_monthly";
  const save=useMutation({
    mutationFn:()=>{
      const cents=parseRateDollars(amount);
      if(cents==null||cents>2_147_483_647)throw new Error("Enter a valid pay amount, such as 32.50 or 5000.00.");
      if(!from)throw new Error("Choose when this pay starts.");
      return setCompensation(profileId,basis,cents,monthlyBoundary?`${from.slice(0,7)}-01`:from);
    },
    onSuccess:()=>{setOpen(false);onSaved();},
  });
  return <section className="compensation-panel" aria-label={`Pay for ${name}`}>
    <div className="compensation-heading"><div>
      <span className="field-label">Pay</span>
      <strong>{selected?formatCompensation(selected):"No rate on file"}</strong>
      <small>As of {month}-01{selected?` · effective ${selected.effectiveFrom}`:""}</small>
    </div>{canSet&&!open&&<button type="button" className="button-like" onClick={()=>{
      setBasis(current?.payBasis??"hourly");
      setAmount(current?String((current.payBasis==="salary_monthly"?current.monthlyCents??0:current.hourlyCents)/100):"");
      setFrom(current?.payBasis==="salary_monthly"?`${month}-01`:today);save.reset();setOpen(true);
    }}>Set pay</button>}</div>
    {canSet&&open&&<div className="compensation-form">
      <label>Pay type<select aria-label="Pay type" value={basis} onChange={e=>setBasis(e.target.value as PayBasis)}>
        <option value="hourly">Hourly</option><option value="salary_monthly">Salary — monthly</option>
      </select></label>
      <label>{basis==="salary_monthly"?"Monthly salary ($)":"Hourly rate ($)"}<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder={basis==="salary_monthly"?"5,000.00":"32.50"}/></label>
      <label>{monthlyBoundary?"Starting month":"Starts on"}<input type={monthlyBoundary?"month":"date"} value={monthlyBoundary?from.slice(0,7):from} onChange={e=>setFrom(monthlyBoundary&&e.target.value?`${e.target.value}-01`:e.target.value)}/></label>
      {monthlyBoundary&&<p className="muted compensation-full">A fixed amount for each calendar month, beginning on the first. It continues until you set a new rate. Clocked hours still track work on jobs.</p>}
      {save.isError&&<p role="alert" className="error compensation-full">{formatApiError(save.error)}</p>}
      <div className="compensation-actions compensation-full"><button type="button" className="action-btn primary" disabled={save.isPending||!amount.trim()||!from} onClick={()=>save.mutate()}>{save.isPending?"Saving…":"Save pay"}</button><button type="button" className="button-like" disabled={save.isPending} onClick={()=>setOpen(false)}>Cancel</button></div>
    </div>}
    {rates.length>0&&<details className="compensation-history"><summary>Pay history</summary><ul>{rates.map(rate=><li key={rate.id}><span>{rate.effectiveFrom}{rate.effectiveFrom>today?" · scheduled":""}</span><strong>{formatCompensation(rate)}</strong></li>)}</ul></details>}
  </section>;
}
