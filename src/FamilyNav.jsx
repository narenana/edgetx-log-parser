import React from 'react'
import {familyNav} from '../scripts/brand-shell.mjs'
export default function FamilyNav(){return <div className="family-app-nav" dangerouslySetInnerHTML={{__html:familyNav({active:'logs',assets:'./assets/family'})}}/>}
